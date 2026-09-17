import { randomUUID } from 'node:crypto'
import { findEvent } from '@horizon/contracts'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ChangeAccountStatusUseCase,
  OpenAccountUseCase,
} from '@/application/use-cases/manage-accounts'
import { RecordEntryUseCase, ReverseEntryUseCase } from '@/application/use-cases/manage-journal'
import {
  CancelTransferUseCase,
  PostTransferUseCase,
} from '@/application/use-cases/manage-transfers'
import { TreasuryDatabase } from '@/infrastructure/database/drizzle/treasury-database'

const clock = { now: () => new Date() }
let database: TreasuryDatabase
let application: ReturnType<typeof postgres>
let administrator: ReturnType<typeof postgres>

beforeAll(() => {
  database = new TreasuryDatabase({ url: process.env.DATABASE_URL ?? '' })
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

async function workspace() {
  const tenantId = randomUUID()
  const context = (key = randomUUID()) => ({
    tenantId,
    actor: 'user-1',
    requestId: null,
    idempotencyKey: key,
  })
  const open = async (name: string, opening = '0', openedOn = '2026-09-01') =>
    value<{ id: string }>(
      await new OpenAccountUseCase(database, clock).execute({
        context: context(),
        account: {
          kind: 'bank',
          name,
          currency: 'BRL',
          bank: { bankCode: '001', branch: '1234-5', accountNumber: '98765-0' },
          openedOn,
          openingBalance: { amount: opening, direction: 'inflow' },
        },
      }),
    ).id
  const record = async (
    accountId: string,
    direction: 'inflow' | 'outflow',
    amount: string,
    valueOn: string,
  ) =>
    value<{ id: string }>(
      await new RecordEntryUseCase(database, clock).execute({
        context: context(),
        accountId,
        entry: { direction, amount, currency: 'BRL', valueOn },
      }),
    ).id
  const balances = async (asOf = '2026-09-30') =>
    Object.fromEntries(
      (await database.listAccounts(tenantId, asOf)).map((row) => [row.name, row.bookBalance]),
    )
  return { tenantId, context, open, record, balances }
}

describe('accounts and the journal', () => {
  it('opens an account with its opening balance, once per key and once per name', async () => {
    const { tenantId, context, balances } = await workspace()
    const opening = new OpenAccountUseCase(database, clock)
    const account = {
      kind: 'cash' as const,
      name: 'Caixa',
      currency: 'BRL',
      openedOn: '2026-09-01',
      openingBalance: { amount: '50000', direction: 'inflow' as const },
    }
    const key = randomUUID()
    const first = value<{ id: string }>(await opening.execute({ context: context(key), account }))
    const replay = value<{ id: string }>(await opening.execute({ context: context(key), account }))
    expect(replay.id).toBe(first.id)
    expect((await opening.execute({ context: context(), account })).isLeft()).toBe(true)
    expect(await balances()).toEqual({ Caixa: '50000' })
    expect((await database.listAccounts(tenantId, '2026-08-31'))[0]?.bookBalance).toBe('0')
  })

  it('computes statements and timelines from the journal, backdated entries included', async () => {
    const { tenantId, open, record } = await workspace()
    const checking = await open('Checking', '10000')
    await record(checking, 'outflow', '2500', '2026-09-10')
    await record(checking, 'inflow', '4000', '2026-09-20')
    // Recorded last, dated first: every later running balance moves with it.
    await record(checking, 'outflow', '1000', '2026-09-05')
    await record(checking, 'inflow', '99999', '2026-10-15')

    const statement = await database.accountStatement(tenantId, checking, {
      from: '2026-09-06',
      to: '2026-09-30',
      limit: 50,
      offset: 0,
    })
    expect(statement.openingBalance).toBe('9000')
    expect(statement.lines.map((line) => [line.valueOn, line.runningBalance])).toEqual([
      ['2026-09-10', '6500'],
      ['2026-09-20', '10500'],
    ])
    expect(statement.closingBalance).toBe('10500')

    const [account] = await database.listAccounts(tenantId, '2026-09-30')
    expect(account).toMatchObject({
      bookBalance: '10500',
      projectedBalance: '110499',
      reconciledBalance: '0',
      statementBalance: null,
    })
    const timeline = await database.balanceTimeline(tenantId, checking, {
      from: '2026-09-04',
      to: '2026-09-06',
    })
    expect(timeline).toEqual([
      { day: '2026-09-04', balance: '10000' },
      { day: '2026-09-05', balance: '9000' },
      { day: '2026-09-06', balance: '9000' },
    ])
  })

  it('refuses entries before opening, on inactive accounts and in another currency', async () => {
    const { context, open, tenantId } = await workspace()
    const checking = await open('Checking')
    const recordOn = (valueOn: string, currency = 'BRL') =>
      new RecordEntryUseCase(database, clock).execute({
        context: context(),
        accountId: checking,
        entry: { direction: 'inflow', amount: '1', currency, valueOn },
      })
    expect((await recordOn('2026-08-31')).isLeft()).toBe(true)
    expect((await recordOn('2026-09-02', 'USD')).isLeft()).toBe(true)
    value(
      await new ChangeAccountStatusUseCase(database, clock).execute({
        context: { tenantId, actor: 'user-1', requestId: null },
        accountId: checking,
        active: false,
      }),
    )
    expect((await recordOn('2026-09-02')).isLeft()).toBe(true)
  })

  it('reverses a manual entry once and leaves the original in the journal', async () => {
    const { tenantId, context, open, record } = await workspace()
    const checking = await open('Checking', '10000')
    const fee = await record(checking, 'outflow', '1200', '2026-09-10')
    const reverse = new ReverseEntryUseCase(database, clock)
    value(await reverse.execute({ context: context(), entryId: fee, reason: 'Bank refunded it' }))
    expect(
      (await reverse.execute({ context: context(), entryId: fee, reason: 'Again' })).isLeft(),
    ).toBe(true)
    const statement = await database.accountStatement(tenantId, checking, {
      from: '2026-09-01',
      to: '2026-09-30',
      limit: 50,
      offset: 0,
    })
    expect(statement.closingBalance).toBe('10000')
    expect(statement.lines.find((line) => line.id === fee)?.reversedBy).not.toBeNull()
    expect(statement.lines).toHaveLength(3)
  })
})

describe('transfers', () => {
  it('moves money with a fee, cancels with inverse entries and publishes each fact', async () => {
    const { tenantId, context, open, balances } = await workspace()
    const checking = await open('Checking', '100000')
    const savings = await open('Savings')
    const key = randomUUID()
    const post = new PostTransferUseCase(database, clock)
    const transfer = {
      fromAccountId: checking,
      toAccountId: savings,
      amount: '30000',
      fee: '350',
      currency: 'BRL',
      valueOn: '2026-09-15',
    }
    const { id } = value<{ id: string }>(await post.execute({ context: context(key), transfer }))
    value(await post.execute({ context: context(key), transfer }))
    expect(await balances()).toEqual({ Checking: '69650', Savings: '30000' })

    const cancel = new CancelTransferUseCase(database, clock)
    value(await cancel.execute({ context: context(), transferId: id, reason: 'Wrong account' }))
    expect(
      (await cancel.execute({ context: context(), transferId: id, reason: 'Again' })).isLeft(),
    ).toBe(true)
    expect(await balances()).toEqual({ Checking: '100000', Savings: '0' })
    expect((await database.listTransfers(tenantId, 10))[0]).toMatchObject({
      status: 'cancelled',
      fromAccountName: 'Checking',
      cancellationReason: 'Wrong account',
    })

    const events = await administrator<{ event_type: string; payload: unknown }[]>`
      select event_type, payload from outbox where tenant_id = ${tenantId} order by created_at, id`
    const types = events.map((event) => event.event_type)
    expect(types.filter((type) => type === 'treasury.transfer.posted')).toHaveLength(1)
    expect(types.filter((type) => type === 'treasury.transfer.cancelled')).toHaveLength(1)
    expect(types.filter((type) => type === 'treasury.entry.recorded')).toHaveLength(7)
    for (const event of events)
      expect(findEvent(event.event_type, 1)?.payload.safeParse(event.payload).success).toBe(true)
  })

  it('refuses a leg reversal, a transfer to the same account and another tenant', async () => {
    const { tenantId, context, open } = await workspace()
    const checking = await open('Checking', '1000')
    const savings = await open('Savings')
    const { id } = value<{ id: string }>(
      await new PostTransferUseCase(database, clock).execute({
        context: context(),
        transfer: {
          fromAccountId: checking,
          toAccountId: savings,
          amount: '100',
          currency: 'BRL',
          valueOn: '2026-09-15',
        },
      }),
    )
    const statement = await database.accountStatement(tenantId, checking, {
      from: '2026-09-01',
      to: '2026-09-30',
      limit: 50,
      offset: 0,
    })
    const leg = statement.lines.find((line) => line.transferId === id)
    expect(
      (
        await new ReverseEntryUseCase(database, clock).execute({
          context: context(),
          entryId: leg?.id ?? '',
          reason: 'Should cancel instead',
        })
      ).isLeft(),
    ).toBe(true)
    expect(
      (
        await new PostTransferUseCase(database, clock).execute({
          context: context(),
          transfer: {
            fromAccountId: checking,
            toAccountId: checking,
            amount: '1',
            currency: 'BRL',
            valueOn: '2026-09-15',
          },
        })
      ).isLeft(),
    ).toBe(true)
    const other = await workspace()
    expect(await database.listTransfers(other.tenantId, 10)).toEqual([])
    expect(
      (
        await new CancelTransferUseCase(database, clock).execute({
          context: other.context(),
          transferId: id,
          reason: 'Not mine',
        })
      ).isLeft(),
    ).toBe(true)
  })

  it('keeps money constant under concurrent transfers in both directions', async () => {
    const { context, open, balances } = await workspace()
    const a = await open('Alpha', '1000000')
    const b = await open('Beta', '1000000')
    const post = new PostTransferUseCase(database, clock)
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        post.execute({
          context: context(),
          transfer: {
            fromAccountId: index % 2 === 0 ? a : b,
            toAccountId: index % 2 === 0 ? b : a,
            amount: String(1000 + index),
            fee: '10',
            currency: 'BRL',
            valueOn: '2026-09-15',
          },
        }),
      ),
    )
    expect(results.every((result) => result.isRight())).toBe(true)
    const totals = await balances()
    expect(BigInt(totals.Alpha ?? '0') + BigInt(totals.Beta ?? '0')).toBe(2_000_000n - 20n * 10n)
  })
})

describe('the database guards the journal', () => {
  it('refuses a transfer without its legs, and any edit or deletion of an entry', async () => {
    const { tenantId, open, record } = await workspace()
    const a = await open('Alpha', '1000')
    const b = await open('Beta')
    const entry = await record(a, 'inflow', '5', '2026-09-02')
    const asTenant = (statement: (sql: postgres.TransactionSql) => Promise<unknown>) =>
      application.begin(async (sql) => {
        await sql`select set_config('app.current_tenant', ${tenantId}, true)`
        return statement(sql)
      })
    await expect(
      asTenant(
        (sql) => sql`insert into transfers (id, tenant_id, from_account_id, to_account_id, amount,
          currency, value_on, status, posted_at)
          values (${randomUUID()}, ${tenantId}, ${a}, ${b}, 100, 'BRL', '2026-09-10', 'posted', now())`,
      ),
    ).rejects.toThrow(/must have exactly one outflow and one inflow leg/)
    await expect(
      asTenant((sql) => sql`update journal_entries set amount = 1 where id = ${entry}`),
    ).rejects.toThrow(/permission denied/)
    await expect(
      asTenant((sql) => sql`delete from journal_entries where id = ${entry}`),
    ).rejects.toThrow(/permission denied|append-only/)
  })
})
