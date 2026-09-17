import { randomBytes, randomUUID } from 'node:crypto'
import type { EventEnvelope } from '@horizon/contracts'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LedgerModuleEventHandlers } from '@/application/consume-module-events'
import { OpenAccountUseCase } from '@/application/use-cases/manage-chart'
import { ClosePeriodUseCase, ReopenPeriodUseCase } from '@/application/use-cases/manage-periods'
import { DefineAccountMappingUseCase } from '@/application/use-cases/map-accounts'
import { ReplayPendingFactsUseCase } from '@/application/use-cases/replay-pending'
import type { PostingRole } from '@/domain/entities/account-mapping'
import { LedgerDatabase } from '@/infrastructure/database/drizzle/ledger-database'

const clock = { now: () => new Date() }
let database: LedgerDatabase
let administrator: ReturnType<typeof postgres>
let handlers: LedgerModuleEventHandlers

beforeAll(() => {
  database = new LedgerDatabase({ url: process.env.DATABASE_URL ?? '' })
  administrator = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
  handlers = new LedgerModuleEventHandlers(database, clock)
})

afterAll(async () => {
  await Promise.allSettled([database?.close(), administrator?.end()])
})

function value<T>(result: { isLeft(): boolean; value: unknown }): T {
  if (result.isLeft()) throw result.value
  return result.value as T
}

const FULL_YEAR = { from: '2026-01-01', to: '2026-12-31' }
const brl = (amount: string) => ({ amount, currency: 'BRL' })

/** A chart with one account per part, and the mappings that put each in its place. */
const CHART: readonly (readonly [PostingRole, string, string, string])[] = [
  ['receivables', '1.01', 'Clientes', 'asset'],
  ['cash', '1.02', 'Bancos', 'asset'],
  ['suspense', '1.09', 'A classificar', 'asset'],
  ['payables', '2.01', 'Fornecedores', 'liability'],
  ['opening-balance', '5.01', 'Saldo inicial', 'equity'],
  ['revenue', '3.01', 'Receita de vendas', 'revenue'],
  ['discount-received', '3.02', 'Descontos obtidos', 'revenue'],
  ['financial-income', '3.03', 'Receitas financeiras', 'revenue'],
  ['expense', '4.01', 'Despesas gerais', 'expense'],
  ['discount-granted', '4.02', 'Descontos concedidos', 'expense'],
  ['financial-expense', '4.03', 'Despesas financeiras', 'expense'],
  ['bank-fees', '4.04', 'Tarifas bancárias', 'expense'],
]

type Workspace = Awaited<ReturnType<typeof workspace>>

async function workspace(options: { mapped?: boolean } = {}) {
  const tenantId = randomUUID()
  const context = () => ({ tenantId, actor: 'ana', requestId: null })
  const keyed = () => ({ ...context(), idempotencyKey: randomUUID() })
  const opening = new OpenAccountUseCase(database, clock)
  const open = async (code: string, name: string, type: string, postable = true) =>
    value<{ id: string }>(
      await opening.execute({
        context: keyed(),
        account: {
          code,
          name,
          type: type as 'asset',
          postable,
          currency: 'BRL',
        },
      }),
    ).id

  for (const [code, name, type] of [
    ['1', 'Ativo', 'asset'],
    ['2', 'Passivo', 'liability'],
    ['3', 'Receitas', 'revenue'],
    ['4', 'Despesas', 'expense'],
    ['5', 'Patrimônio', 'equity'],
  ] as const)
    await open(code, name, type, false)

  const accounts = new Map<PostingRole, string>()
  const mapping = new DefineAccountMappingUseCase(database, clock)
  for (const [role, code, name, type] of CHART) {
    const id = await open(code, name, type)
    accounts.set(role, id)
    if (options.mapped !== false)
      value(await mapping.execute({ context: context(), role, key: null, accountId: id }))
  }
  return { tenantId, context, keyed, accounts, mapping, open }
}

function envelope(tenantId: string, eventType: string, payload: unknown): EventEnvelope {
  return {
    eventId: randomUUID(),
    tenantId,
    eventType,
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    traceId: randomBytes(16).toString('hex'),
    payload,
  } as EventEnvelope
}

async function deliver(tenantId: string, eventType: string, payload: unknown) {
  const handler = handlers.handlers[eventType]
  if (!handler) throw new Error(`no handler for ${eventType}`)
  await handler(envelope(tenantId, eventType, payload))
}

const receivablePosted = (over: Record<string, unknown> = {}) => ({
  titleId: randomUUID(),
  partyId: randomUUID(),
  documentNumber: 'NF-1001',
  origin: { type: 'manual' },
  categoryId: randomUUID(),
  issuedOn: '2026-05-01',
  competenceOn: '2026-05-01',
  total: brl('100000'),
  installments: [{ number: 1, dueOn: '2026-06-01', amount: brl('100000') }],
  allocations: [],
  postedAt: '2026-05-01T12:00:00.000Z',
  ...over,
})

const settlementRecorded = (titleId: string, over: Record<string, unknown> = {}) => ({
  settlementId: randomUUID(),
  titleId,
  direction: 'receivable',
  partyId: randomUUID(),
  installmentNumber: 1,
  settledOn: '2026-06-01',
  received: brl('100000'),
  discount: brl('0'),
  interest: brl('0'),
  penalty: brl('0'),
  paymentMethodId: null,
  outstanding: brl('0'),
  recordedAt: '2026-06-01T12:00:00.000Z',
  ...over,
})

/** Every transaction in the workspace, oldest first, so a test reads chronologically. */
async function journalOf(space: Workspace) {
  const listed = await database.listTransactions(space.tenantId, {
    ...FULL_YEAR,
    limit: 100,
    offset: 0,
  })
  const details = await Promise.all(
    listed.data.map((row) => database.transactionDetail(space.tenantId, row.id)),
  )
  return details.reverse().flatMap((detail) =>
    detail
      ? [
          {
            reference: detail.reference,
            status: detail.status,
            total: detail.total,
            lines: detail.lines.map((line) => `${line.accountCode} ${line.side} ${line.amount}`),
          },
        ]
      : [],
  )
}

describe('a title reported by financial', () => {
  it('raises the claim against revenue and settles it against cash', async () => {
    const space = await workspace()
    const title = receivablePosted()
    await deliver(space.tenantId, 'financial.receivable.posted', title)
    await deliver(
      space.tenantId,
      'financial.settlement.recorded',
      settlementRecorded(title.titleId),
    )

    const journal = await journalOf(space)
    expect(journal).toHaveLength(2)
    expect(journal.map((entry) => entry.reference)).toEqual(['NF-1001', 'NF-1001'])
    expect(journal.flatMap((entry) => entry.lines)).toEqual(
      expect.arrayContaining([
        '1.01 debit 100000',
        '3.01 credit 100000',
        '1.02 debit 100000',
        '1.01 credit 100000',
      ]),
    )
    const trial = await database.trialBalance(space.tenantId, FULL_YEAR)
    expect(trial.totalDebits).toBe(trial.totalCredits)
    // The claim was raised and collected, so it nets to nothing; the cash and the revenue stay.
    expect(trial.rows.find((row) => row.code === '1.01')?.closing).toBe('0')
    expect(trial.rows.find((row) => row.code === '1.02')?.closing).toBe('100000')
    expect(trial.rows.find((row) => row.code === '3.01')?.closing).toBe('100000')
  })

  it('posts a settlement with discount, interest and penalty, and keeps the books balanced', async () => {
    const space = await workspace()
    const title = receivablePosted({ total: brl('100000') })
    await deliver(space.tenantId, 'financial.receivable.posted', title)
    await deliver(
      space.tenantId,
      'financial.settlement.recorded',
      settlementRecorded(title.titleId, {
        received: brl('99000'),
        discount: brl('2000'),
        interest: brl('1000'),
      }),
    )
    const journal = await journalOf(space)
    expect(journal[1]?.lines).toEqual([
      '1.02 debit 99000',
      '4.02 debit 2000',
      '3.03 credit 1000',
      '1.01 credit 100000',
    ])
    const trial = await database.trialBalance(space.tenantId, FULL_YEAR)
    expect(trial.totalDebits).toBe(trial.totalCredits)
    expect(trial.rows.find((row) => row.code === '1.01')?.closing).toBe('0')
  })

  it('undoes what it posted when financial reverses the title', async () => {
    const space = await workspace()
    const title = receivablePosted()
    await deliver(space.tenantId, 'financial.receivable.posted', title)
    await deliver(space.tenantId, 'financial.receivable.reversed', {
      titleId: title.titleId,
      partyId: title.partyId,
      reversedAt: '2026-05-10T12:00:00.000Z',
      reason: 'Emitida em duplicidade',
    })
    const journal = await journalOf(space)
    expect(journal.map((entry) => entry.status).sort()).toEqual(['posted', 'reversed'])
    const trial = await database.trialBalance(space.tenantId, FULL_YEAR)
    expect(trial.rows.every((row) => row.closing === '0')).toBe(true)
  })

  it('posts one transaction however many times the event is delivered', async () => {
    const space = await workspace()
    const title = receivablePosted()
    const payload = title
    await deliver(space.tenantId, 'financial.receivable.posted', payload)
    // The same event id is refused by the inbox; a new one still resolves to the same fact.
    const repeated = envelope(space.tenantId, 'financial.receivable.posted', payload)
    const handler = handlers.handlers['financial.receivable.posted']
    await handler?.(repeated)
    await handler?.(repeated)
    await deliver(space.tenantId, 'financial.receivable.posted', payload)
    expect(await journalOf(space)).toHaveLength(1)
  })
})

describe('a movement reported by treasury', () => {
  it('moves cash between accounts without touching profit, and books the fee as expense', async () => {
    const space = await workspace()
    await deliver(space.tenantId, 'treasury.transfer.posted', {
      transferId: randomUUID(),
      fromAccountId: randomUUID(),
      toAccountId: randomUUID(),
      amount: brl('50000'),
      fee: brl('350'),
      valueOn: '2026-07-10',
      postedAt: '2026-07-10T12:00:00.000Z',
    })
    const [transfer] = await journalOf(space)
    expect(transfer?.lines).toEqual([
      '1.02 debit 50000',
      '1.02 credit 50000',
      '4.04 debit 350',
      '1.02 credit 350',
    ])
    const trial = await database.trialBalance(space.tenantId, FULL_YEAR)
    expect(trial.rows.find((row) => row.code === '1.02')?.closing).toBe('-350')
    expect(trial.rows.find((row) => row.code === '4.04')?.closing).toBe('350')
  })

  it('books an opening balance and a manual entry, and ignores what other facts already cover', async () => {
    const space = await workspace()
    const entry = (source: string, direction: string) => ({
      entryId: randomUUID(),
      accountId: randomUUID(),
      direction,
      amount: brl('1000'),
      valueOn: '2026-07-01',
      source: { type: source, id: null },
      reverses: null,
      recordedAt: '2026-07-01T12:00:00.000Z',
    })
    await deliver(space.tenantId, 'treasury.entry.recorded', entry('opening', 'inflow'))
    await deliver(space.tenantId, 'treasury.entry.recorded', entry('manual', 'outflow'))
    for (const ignored of ['transfer', 'transfer-fee', 'settlement', 'reversal'])
      await deliver(space.tenantId, 'treasury.entry.recorded', entry(ignored, 'inflow'))

    const journal = await journalOf(space)
    expect(journal).toHaveLength(2)
    expect(journal.flatMap((row) => row.lines)).toEqual(
      expect.arrayContaining([
        '1.02 debit 1000',
        '5.01 credit 1000',
        '1.02 credit 1000',
        '1.09 debit 1000',
      ]),
    )
  })
})

describe('a fact the workspace cannot post yet', () => {
  it('waits as pending, and posts once the account is mapped and it is replayed', async () => {
    const space = await workspace({ mapped: false })
    const title = receivablePosted()
    await deliver(space.tenantId, 'financial.receivable.posted', title)

    const pending = await database.listPendingFacts(space.tenantId, 10)
    expect(pending.total).toBe(1)
    expect(pending.data[0]).toMatchObject({ kind: 'receivable', reference: 'NF-1001' })
    expect(pending.data[0]?.reason).toMatch(/no account is mapped/)
    expect(await journalOf(space)).toHaveLength(0)

    for (const role of ['receivables', 'revenue'] as const) {
      const accountId = space.accounts.get(role)
      if (!accountId) throw new Error(`missing ${role}`)
      value(await space.mapping.execute({ context: space.context(), role, key: null, accountId }))
    }
    const replayed = value<{ attempted: number; posted: number; stillPending: number }>(
      await new ReplayPendingFactsUseCase(database, clock).execute({ context: space.context() }),
    )
    expect(replayed).toEqual({ attempted: 1, posted: 1, stillPending: 0 })
    expect(await journalOf(space)).toHaveLength(1)
    expect((await database.listPendingFacts(space.tenantId, 10)).total).toBe(0)
  })

  it('waits when the month is closed, and posts after it is reopened', async () => {
    const space = await workspace()
    value(
      await new ClosePeriodUseCase(database, clock).execute({
        context: space.keyed(),
        period: '2026-05',
      }),
    )
    await deliver(space.tenantId, 'financial.receivable.posted', receivablePosted())
    const pending = await database.listPendingFacts(space.tenantId, 10)
    expect(pending.data[0]?.reason).toMatch(/period 2026-05 is closed/)

    value(
      await new ReopenPeriodUseCase(database, clock).execute({
        context: space.keyed(),
        period: '2026-05',
        reason: 'A nota de maio chegou atrasada',
      }),
    )
    value(
      await new ReplayPendingFactsUseCase(database, clock).execute({ context: space.context() }),
    )
    expect(await journalOf(space)).toHaveLength(1)
  })

  it('is never posted after the module that reported it undid it', async () => {
    const space = await workspace({ mapped: false })
    const title = receivablePosted()
    await deliver(space.tenantId, 'financial.receivable.posted', title)
    await deliver(space.tenantId, 'financial.receivable.reversed', {
      titleId: title.titleId,
      partyId: title.partyId,
      reversedAt: '2026-05-10T12:00:00.000Z',
      reason: 'Emitida em duplicidade',
    })
    for (const [role, accountId] of space.accounts)
      value(await space.mapping.execute({ context: space.context(), role, key: null, accountId }))
    const replayed = value<{ attempted: number }>(
      await new ReplayPendingFactsUseCase(database, clock).execute({ context: space.context() }),
    )
    expect(replayed.attempted).toBe(0)
    expect(await journalOf(space)).toHaveLength(0)
  })
})

describe('replaying every event into an empty ledger', () => {
  it('produces the same balances', async () => {
    const script = (() => {
      const title = receivablePosted()
      const paid = settlementRecorded(title.titleId, {
        received: brl('99000'),
        discount: brl('2000'),
        interest: brl('1000'),
      })
      return [
        ['financial.receivable.posted', title],
        ['financial.settlement.recorded', paid],
        [
          'treasury.transfer.posted',
          {
            transferId: randomUUID(),
            fromAccountId: randomUUID(),
            toAccountId: randomUUID(),
            amount: brl('20000'),
            fee: brl('120'),
            valueOn: '2026-07-10',
            postedAt: '2026-07-10T12:00:00.000Z',
          },
        ],
      ] as const
    })()

    const play = async (order: readonly number[]) => {
      const space = await workspace()
      for (const index of order) {
        const step = script[index]
        if (step) await deliver(space.tenantId, step[0], step[1])
      }
      const trial = await database.trialBalance(space.tenantId, FULL_YEAR)
      return trial.rows.map((row) => `${row.code}=${row.closing}`).sort()
    }

    const forwards = await play([0, 1, 2])
    // The same facts arriving in another order, into a ledger that knows nothing yet.
    const shuffled = await play([2, 0, 1])
    expect(shuffled).toEqual(forwards)
    // And delivered twice over, which must change nothing.
    const doubled = await play([0, 1, 2, 0, 1, 2])
    expect(doubled).toEqual(forwards)
  })
})

describe('the database itself', () => {
  it('refuses a second transaction against a fact that already posted one', async () => {
    const space = await workspace()
    const title = receivablePosted()
    await deliver(space.tenantId, 'financial.receivable.posted', title)
    const application = postgres(process.env.DATABASE_URL ?? '', { max: 1 })
    try {
      await expect(
        application.begin(async (sql) => {
          await sql`select set_config('app.current_tenant', ${space.tenantId}, true)`
          return sql`update posting_facts set transaction_id = ${randomUUID()}
            where fact_id = ${title.titleId}`
        }),
      ).rejects.toThrow(/already posted transaction/)
    } finally {
      await application.end()
    }
  })

  it("keeps one workspace's postings invisible to another", async () => {
    const first = await workspace()
    const second = await workspace()
    await deliver(first.tenantId, 'financial.receivable.posted', receivablePosted())
    expect(await journalOf(second)).toHaveLength(0)
    expect((await database.listMappings(second.tenantId)).length).toBe(CHART.length)
    expect((await database.listPendingFacts(second.tenantId, 10)).total).toBe(0)
  })
})
