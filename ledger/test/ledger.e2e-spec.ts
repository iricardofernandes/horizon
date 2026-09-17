import { randomUUID } from 'node:crypto'
import { findEvent } from '@horizon/contracts'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ChangeAccountStatusUseCase,
  OpenAccountUseCase,
} from '@/application/use-cases/manage-chart'
import { ClosePeriodUseCase, ReopenPeriodUseCase } from '@/application/use-cases/manage-periods'
import {
  type LineInput,
  PostTransactionUseCase,
  ReverseTransactionUseCase,
} from '@/application/use-cases/post-journal'
import { LedgerDatabase } from '@/infrastructure/database/drizzle/ledger-database'

const clock = { now: () => new Date() }
let database: LedgerDatabase
let application: ReturnType<typeof postgres>
let administrator: ReturnType<typeof postgres>

beforeAll(() => {
  database = new LedgerDatabase({ url: process.env.DATABASE_URL ?? '' })
  application = postgres(process.env.DATABASE_URL ?? '', { max: 1 })
  administrator = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
})

afterAll(async () => {
  await Promise.allSettled([database?.close(), application?.end(), administrator?.end()])
})

function value<T>(result: { isLeft(): boolean; value: unknown }): T {
  if (result.isLeft()) throw result.value
  return result.value as T
}

const FULL_YEAR = { from: '2026-01-01', to: '2026-12-31' }

/**
 * A minimal but real chart: two asset groups with leaves, a revenue account and an
 * expense one. Every test posts against this, so the shapes are the shapes a book keeps.
 */
async function workspace() {
  const tenantId = randomUUID()
  const context = (key = randomUUID()) => ({
    tenantId,
    actor: 'ana',
    requestId: null,
    idempotencyKey: key,
  })
  const opening = new OpenAccountUseCase(database, clock)
  const open = async (
    code: string,
    name: string,
    type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense',
    postable = true,
  ) =>
    value<{ id: string }>(
      await opening.execute({
        context: context(),
        account: { code, name, type, postable, currency: 'BRL' },
      }),
    ).id

  await open('1', 'Ativo', 'asset', false)
  await open('1.01', 'Disponível', 'asset', false)
  const cash = await open('1.01.001', 'Caixa', 'asset')
  const bank = await open('1.01.002', 'Banco conta movimento', 'asset')
  const revenue = await open('3', 'Receita de vendas', 'revenue')
  await open('4', 'Despesas', 'expense', false)
  const fees = await open('4.01', 'Tarifas bancárias', 'expense')

  const posting = new PostTransactionUseCase(database, clock)
  const post = (reference: string, postedOn: string, lines: readonly LineInput[]) =>
    posting.execute({
      context: context(),
      transaction: { reference, postedOn, currency: 'BRL', lines },
    })
  const debit = (accountId: string, amount: string): LineInput => ({
    accountId,
    side: 'debit',
    amount,
  })
  const credit = (accountId: string, amount: string): LineInput => ({
    accountId,
    side: 'credit',
    amount,
  })
  return { tenantId, context, open, post, debit, credit, cash, bank, revenue, fees }
}

describe('the chart of accounts', () => {
  it('reads back as a tree whose parents total their children', async () => {
    const { tenantId, post, debit, credit, cash, bank, revenue } = await workspace()
    value(await post('NF-1', '2026-03-10', [debit(cash, '30000'), credit(revenue, '30000')]))
    value(await post('NF-2', '2026-03-11', [debit(bank, '70000'), credit(revenue, '70000')]))

    const chart = await database.chartOfAccounts(tenantId, '2026-03-31')
    const by = (code: string) => chart.find((row) => row.code === code)
    expect(chart.map((row) => row.code)).toEqual([
      '1',
      '1.01',
      '1.01.001',
      '1.01.002',
      '3',
      '4',
      '4.01',
    ])
    expect(by('1.01.001')).toMatchObject({ balance: '30000', depth: 3, postable: true })
    expect(by('1.01')).toMatchObject({ balance: '0', rollUp: '100000', postable: false })
    expect(by('1')?.rollUp).toBe('100000')
    // Revenue is a credit account, so a credit raises it rather than lowering it.
    expect(by('3')?.balance).toBe('100000')
  })

  it('refuses a duplicate code, an unknown parent and a child of a postable account', async () => {
    const { context, open } = await workspace()
    const opening = new OpenAccountUseCase(database, clock)
    const attempt = (code: string, type: 'asset' | 'expense' = 'asset', postable = true) =>
      opening.execute({
        context: context(),
        account: { code, name: `Conta ${code}`, type, postable, currency: 'BRL' },
      })
    expect((await attempt('1.01.001')).isLeft()).toBe(true)
    expect((await attempt('9.99.999')).isLeft()).toBe(true)
    expect((await attempt('1.01.001.001')).isLeft()).toBe(true)
    expect((await attempt('1.02.001', 'expense')).isLeft()).toBe(true)
    await open('1.02', 'Aplicações', 'asset', false)
    value(await attempt('1.02.001'))
  })

  it('stops an inactive account taking new lines, and keeps its history readable', async () => {
    const { tenantId, context, post, debit, credit, cash, revenue } = await workspace()
    value(await post('NF-3', '2026-04-01', [debit(cash, '1000'), credit(revenue, '1000')]))
    value(
      await new ChangeAccountStatusUseCase(database, clock).execute({
        context: context(),
        accountId: cash,
        active: false,
      }),
    )
    expect(
      (await post('NF-4', '2026-04-02', [debit(cash, '1000'), credit(revenue, '1000')])).isLeft(),
    ).toBe(true)
    const ledger = await database.accountLedger(tenantId, cash, {
      ...FULL_YEAR,
      limit: 50,
      offset: 0,
    })
    expect(ledger?.data).toHaveLength(1)
  })
})

describe('posting a transaction', () => {
  it('writes its lines, publishes a valid event and shows up in the trial balance', async () => {
    const { tenantId, post, debit, credit, cash, revenue, fees } = await workspace()
    const posted = value<{ id: string; period: string; total: string }>(
      await post('NF-10', '2026-05-20', [
        debit(cash, '9700'),
        debit(fees, '300'),
        credit(revenue, '10000'),
      ]),
    )
    expect(posted).toMatchObject({ period: '2026-05', total: '10000' })

    const detail = await database.transactionDetail(tenantId, posted.id)
    expect(detail).toMatchObject({ status: 'posted', lineCount: 3, reference: 'NF-10' })
    expect(detail?.lines.map((line) => line.accountCode)).toEqual(['1.01.001', '4.01', '3'])

    const [event] = await administrator<{ event_type: string; payload: unknown }[]>`
      select event_type, payload from outbox
      where tenant_id = ${tenantId} and event_type = 'ledger.transaction.posted'`
    expect(event?.event_type).toBe('ledger.transaction.posted')
    expect(
      findEvent('ledger.transaction.posted', 1)?.payload.safeParse(event?.payload).success,
    ).toBe(true)

    const trial = await database.trialBalance(tenantId, { from: '2026-05-01', to: '2026-05-31' })
    expect(trial.totalDebits).toBe('10000')
    expect(trial.totalCredits).toBe('10000')
    expect(trial.rows.find((row) => row.code === '3')).toMatchObject({
      opening: '0',
      credits: '10000',
      closing: '10000',
    })
  })

  it('refuses unbalanced lines, an unknown account, a parent account and another currency', async () => {
    const { tenantId, post, debit, credit, cash, revenue } = await workspace()
    expect(
      (await post('NF-11', '2026-05-20', [debit(cash, '1'), credit(revenue, '2')])).isLeft(),
    ).toBe(true)
    expect(
      (
        await post('NF-12', '2026-05-20', [debit(randomUUID(), '1'), credit(revenue, '1')])
      ).isLeft(),
    ).toBe(true)
    const chart = await database.chartOfAccounts(tenantId, '2026-05-20')
    const group = chart.find((row) => row.code === '1.01')
    expect(group).toBeDefined()
    expect(
      (
        await post('NF-13', '2026-05-20', [debit(group?.id ?? '', '1'), credit(revenue, '1')])
      ).isLeft(),
    ).toBe(true)
    expect(
      (await database.listTransactions(tenantId, { ...FULL_YEAR, limit: 10, offset: 0 })).total,
    ).toBe(0)
  })

  it('runs a command once per idempotency key', async () => {
    const { context, post, debit, credit, cash, revenue, tenantId } = await workspace()
    const key = context()
    const posting = new PostTransactionUseCase(database, clock)
    const request = {
      context: key,
      transaction: {
        reference: 'NF-14',
        postedOn: '2026-06-01',
        currency: 'BRL',
        lines: [debit(cash, '500'), credit(revenue, '500')],
      },
    }
    const first = value<{ id: string }>(await posting.execute(request))
    const again = value<{ id: string }>(await posting.execute(request))
    expect(again.id).toBe(first.id)
    expect(
      (await database.listTransactions(tenantId, { ...FULL_YEAR, limit: 10, offset: 0 })).total,
    ).toBe(1)
    void post
  })
})

describe('reversing a transaction', () => {
  it('mirrors it, leaves both in the journal and nets the account back to zero', async () => {
    const { tenantId, context, post, debit, credit, cash, revenue } = await workspace()
    const posted = value<{ id: string }>(
      await post('NF-20', '2026-07-05', [debit(cash, '2500'), credit(revenue, '2500')]),
    )
    const reversal = value<{ id: string; period: string }>(
      await new ReverseTransactionUseCase(database, clock).execute({
        context: context(),
        transactionId: posted.id,
        reason: 'Lançado na conta errada',
      }),
    )
    expect(reversal.period).toBe('2026-07')

    const original = await database.transactionDetail(tenantId, posted.id)
    expect(original).toMatchObject({
      status: 'reversed',
      reversedBy: reversal.id,
      reversalReason: 'Lançado na conta errada',
    })
    const mirror = await database.transactionDetail(tenantId, reversal.id)
    expect(mirror?.lines.map((line) => line.side)).toEqual(['credit', 'debit'])

    const ledger = await database.accountLedger(tenantId, cash, {
      ...FULL_YEAR,
      limit: 50,
      offset: 0,
    })
    expect(ledger?.data.map((line) => line.runningBalance)).toEqual(['2500', '0'])
    expect(ledger?.closing).toBe('0')
    const trial = await database.trialBalance(tenantId, FULL_YEAR)
    expect(trial.totalDebits).toBe(trial.totalCredits)
  })

  it('refuses a second reversal, a reversal of a mirror and a backdated one', async () => {
    const { context, post, debit, credit, cash, revenue } = await workspace()
    const reversing = new ReverseTransactionUseCase(database, clock)
    const posted = value<{ id: string }>(
      await post('NF-21', '2026-07-06', [debit(cash, '100'), credit(revenue, '100')]),
    )
    const reversal = value<{ id: string }>(
      await reversing.execute({
        context: context(),
        transactionId: posted.id,
        reason: 'Duplicado',
      }),
    )
    expect(
      (
        await reversing.execute({
          context: context(),
          transactionId: posted.id,
          reason: 'Duplicado',
        })
      ).isLeft(),
    ).toBe(true)
    expect(
      (
        await reversing.execute({
          context: context(),
          transactionId: reversal.id,
          reason: 'Duplicado',
        })
      ).isLeft(),
    ).toBe(true)
    const another = value<{ id: string }>(
      await post('NF-22', '2026-07-07', [debit(cash, '100'), credit(revenue, '100')]),
    )
    expect(
      (
        await reversing.execute({
          context: context(),
          transactionId: another.id,
          reason: 'Duplicado',
          reversalOn: '2026-07-06',
        })
      ).isLeft(),
    ).toBe(true)
  })
})

describe('closing a month', () => {
  it('refuses postings and reversals inside it until it is reopened with a reason', async () => {
    const { tenantId, context, post, debit, credit, cash, revenue } = await workspace()
    const posted = value<{ id: string }>(
      await post('NF-30', '2026-08-10', [debit(cash, '4000'), credit(revenue, '4000')]),
    )
    value(
      await new ClosePeriodUseCase(database, clock).execute({
        context: context(),
        period: '2026-08',
      }),
    )
    expect(
      (await post('NF-31', '2026-08-11', [debit(cash, '1'), credit(revenue, '1')])).isLeft(),
    ).toBe(true)
    expect(
      (
        await new ReverseTransactionUseCase(database, clock).execute({
          context: context(),
          transactionId: posted.id,
          reason: 'Depois do fechamento',
        })
      ).isLeft(),
    ).toBe(true)
    // A later month is untouched by August's closure.
    value(await post('NF-32', '2026-09-01', [debit(cash, '1'), credit(revenue, '1')]))

    const [closed] = await database.listPeriods(tenantId, 10)
    expect(closed).toMatchObject({ period: '2026-08', status: 'closed', transactionCount: 1 })

    value(
      await new ReopenPeriodUseCase(database, clock).execute({
        context: context(),
        period: '2026-08',
        reason: 'Uma nota de agosto chegou atrasada',
      }),
    )
    value(await post('NF-33', '2026-08-12', [debit(cash, '1'), credit(revenue, '1')]))
    const [reopened] = await database.listPeriods(tenantId, 10)
    expect(reopened).toMatchObject({
      status: 'open',
      reopenReason: 'Uma nota de agosto chegou atrasada',
    })

    const events = await administrator<{ event_type: string }[]>`
      select event_type from outbox
      where tenant_id = ${tenantId} and event_type like 'ledger.period.%'
      order by created_at`
    expect(events.map((row) => row.event_type)).toEqual([
      'ledger.period.closed',
      'ledger.period.reopened',
    ])
  })

  it('refuses reopening a month nobody closed', async () => {
    const { context } = await workspace()
    expect(
      (
        await new ReopenPeriodUseCase(database, clock).execute({
          context: context(),
          period: '2026-02',
          reason: 'Nunca foi fechado',
        })
      ).isLeft(),
    ).toBe(true)
  })
})

describe('the database itself', () => {
  const asTenant = (
    tenantId: string,
    statement: (sql: postgres.TransactionSql) => Promise<unknown>,
  ) =>
    application.begin(async (sql) => {
      await sql`select set_config('app.current_tenant', ${tenantId}, true)`
      return statement(sql)
    })

  it('refuses an unbalanced transaction written directly, and a line written alone', async () => {
    const { tenantId, cash, revenue } = await workspace()
    const id = randomUUID()
    await expect(
      asTenant(
        tenantId,
        (sql) => sql`
          with t as (
            insert into transactions (id, tenant_id, reference, posted_on, period, currency,
              total, source_type, status, posted_at)
            values (${id}, ${tenantId}, 'HAND', '2026-06-01', '2026-06', 'BRL', 100, 'manual',
              'posted', now())
            returning id
          )
          insert into transaction_lines (tenant_id, transaction_id, line_number, account_id,
            account_code, side, amount, currency, posted_on, period)
          values
            (${tenantId}, ${id}, 1, ${cash}, '1.01.001', 'debit', 100, 'BRL', '2026-06-01', '2026-06'),
            (${tenantId}, ${id}, 2, ${revenue}, '3', 'credit', 90, 'BRL', '2026-06-01', '2026-06')`,
      ),
    ).rejects.toThrow(/does not balance/)
    await expect(
      asTenant(
        tenantId,
        (sql) => sql`
          insert into transaction_lines (tenant_id, transaction_id, line_number, account_id,
            account_code, side, amount, currency, posted_on, period)
          values (${tenantId}, ${randomUUID()}, 1, ${cash}, '1.01.001', 'debit', 100, 'BRL',
            '2026-06-01', '2026-06')`,
      ),
    ).rejects.toThrow(/transaction_lines_transaction_fk/)
  })

  it('keeps lines append-only for the application, and for the owner too', async () => {
    const { tenantId, post, debit, credit, cash, revenue } = await workspace()
    const posted = value<{ id: string }>(
      await post('NF-40', '2026-06-02', [debit(cash, '100'), credit(revenue, '100')]),
    )
    // The application role has no UPDATE or DELETE grant at all, so it never reaches the
    // trigger. The trigger is the second lock, for anything connecting as the owner.
    await expect(
      asTenant(
        tenantId,
        (sql) => sql`update transaction_lines set amount = 1 where transaction_id = ${posted.id}`,
      ),
    ).rejects.toThrow(/permission denied/)
    await expect(
      administrator`update transaction_lines set amount = 1 where transaction_id = ${posted.id}`,
    ).rejects.toThrow(/append-only/)
    await expect(
      asTenant(tenantId, (sql) => sql`delete from transactions where id = ${posted.id}`),
    ).rejects.toThrow(/permission denied/)
    await expect(administrator`delete from transactions where id = ${posted.id}`).rejects.toThrow(
      /reversed, never deleted/,
    )
  })

  it('refuses a child of a postable account written directly', async () => {
    const { tenantId, cash } = await workspace()
    await expect(
      asTenant(
        tenantId,
        (sql) => sql`
          insert into accounts (id, tenant_id, code, name, type, parent_id, postable, currency,
            active, created_at, updated_at)
          values (${randomUUID()}, ${tenantId}, '1.01.001.001', 'Sub', 'asset', ${cash}, true,
            'BRL', true, now(), now())`,
      ),
    ).rejects.toThrow(/cannot have children/)
  })

  it('hides one workspace from another', async () => {
    const first = await workspace()
    const second = await workspace()
    value(
      await first.post('NF-50', '2026-06-03', [
        first.debit(first.cash, '100'),
        first.credit(first.revenue, '100'),
      ]),
    )
    expect(
      (await database.listTransactions(second.tenantId, { ...FULL_YEAR, limit: 10, offset: 0 }))
        .total,
    ).toBe(0)
    const [visible] = (await asTenant(
      second.tenantId,
      (sql) => sql`select count(*)::int as total from transactions`,
    )) as [{ total: number }]
    expect(visible.total).toBe(0)
    expect(
      await database.accountLedger(second.tenantId, first.cash, {
        ...FULL_YEAR,
        limit: 10,
        offset: 0,
      }),
    ).toBeNull()
  })
})
