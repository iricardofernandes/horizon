import { sql } from 'drizzle-orm'
import type { Transaction } from './ledger-store'

/**
 * Revenue and expense read the way an accountant states them: positive when the account
 * moved the way its type expects. A revenue account credited 100 shows 100, not −100.
 */
const naturalMovement = sql.raw(`case when a.type = 'revenue'
  then coalesce(credits, 0) - coalesce(debits, 0)
  else coalesce(debits, 0) - coalesce(credits, 0) end`)

export interface IncomeStatementRow {
  readonly accountId: string
  readonly code: string
  readonly name: string
  readonly type: 'revenue' | 'expense'
  readonly depth: number
  readonly postable: boolean
  /** What this account alone moved in the range. */
  readonly amount: string
  /** What it and everything under it moved. */
  readonly rollUp: string
}

export interface IncomeStatement {
  readonly from: string
  readonly to: string
  readonly revenue: readonly IncomeStatementRow[]
  readonly expense: readonly IncomeStatementRow[]
  readonly totalRevenue: string
  readonly totalExpense: string
  /** Revenue less expense: what the period earned, or lost when it is negative. */
  readonly result: string
}

type StatementRow = {
  account_id: string
  code: string
  name: string
  type: string
  depth: number
  postable: boolean
  amount: string
  roll_up: string
}

/**
 * The result of a period, by account.
 *
 * Only revenue and expense accounts take part: an income statement says what the period
 * earned and spent, not what the workspace holds. Every figure is the movement inside the
 * range, never a balance carried from before it, which is what makes two consecutive
 * statements add up to the one that spans both.
 */
export async function incomeStatement(
  tx: Transaction,
  range: { from: string; to: string },
): Promise<IncomeStatement> {
  const rows = await tx.execute<StatementRow>(sql`
    with movement as (
      select l.account_id,
        sum(l.amount) filter (where l.side = 'debit') as debits,
        sum(l.amount) filter (where l.side = 'credit') as credits
      from transaction_lines l
      where l.posted_on between ${range.from}::date and ${range.to}::date
      group by l.account_id
    ),
    own as (
      select a.id, a.code, a.name, a.type, a.postable,
        array_length(string_to_array(a.code, '.'), 1) as depth,
        ${naturalMovement} as amount
      from accounts a
      left join movement m on m.account_id = a.id
      where a.type in ('revenue', 'expense')
    )
    select o.id as account_id, o.code, o.name, o.type, o.depth, o.postable,
      o.amount::text as amount,
      (select coalesce(sum(d.amount), 0) from own d
        where d.id = o.id or d.code like o.code || '.%')::text as roll_up
    from own o
    order by o.code
  `)
  const present = (row: StatementRow): IncomeStatementRow => ({
    accountId: row.account_id,
    code: row.code,
    name: row.name,
    type: row.type === 'revenue' ? 'revenue' : 'expense',
    depth: row.depth,
    postable: row.postable,
    amount: row.amount,
    rollUp: row.roll_up,
  })
  const all = [...rows].map(present)
  // Totals come from the postable accounts alone: adding a parent to its children would
  // count the same money twice.
  const totalOf = (type: 'revenue' | 'expense') =>
    all
      .filter((row) => row.type === type && row.postable)
      .reduce((sum, row) => sum + BigInt(row.amount), 0n)
  const totalRevenue = totalOf('revenue')
  const totalExpense = totalOf('expense')
  return {
    ...range,
    revenue: all.filter((row) => row.type === 'revenue'),
    expense: all.filter((row) => row.type === 'expense'),
    totalRevenue: totalRevenue.toString(),
    totalExpense: totalExpense.toString(),
    result: (totalRevenue - totalExpense).toString(),
  }
}

export const CASH_FLOW_GRAINS = ['day', 'week', 'month'] as const
export type CashFlowGrain = (typeof CASH_FLOW_GRAINS)[number]

export interface CashFlowBucket {
  /** The first day of the bucket, which is also how it is labelled. */
  readonly startsOn: string
  readonly inflow: string
  readonly outflow: string
  readonly net: string
  /** What the cash accounts held at the end of this bucket. */
  readonly closing: string
}

export interface CashFlow {
  readonly from: string
  readonly to: string
  readonly grain: CashFlowGrain
  /** What the cash accounts held the day before the range began. */
  readonly opening: string
  readonly buckets: readonly CashFlowBucket[]
  readonly inflow: string
  readonly outflow: string
  readonly net: string
  readonly closing: string
  /** The accounts counted as cash: the ones the workspace mapped to that part. */
  readonly accounts: readonly { readonly code: string; readonly name: string }[]
}

/**
 * Cash in and out, as the books record it.
 *
 * "Cash" is not guessed from account names: it is exactly the accounts the workspace
 * mapped to the `cash` part of the automatic postings, so this report and those postings
 * can never disagree about what counts. A workspace that has mapped none gets an empty
 * report rather than a wrong one.
 *
 * Every bucket in the range is present, including the ones nothing happened in, because a
 * chart with the quiet weeks missing misreads as a chart with no quiet weeks.
 */
export async function cashFlow(
  tx: Transaction,
  range: { from: string; to: string },
  grain: CashFlowGrain,
): Promise<CashFlow> {
  const accounts = await tx.execute<{ id: string; code: string; name: string }>(sql`
    select a.id, a.code, a.name
    from account_mappings m
    join accounts a on a.tenant_id = m.tenant_id and a.id = m.account_id
    where m.role = 'cash'
    order by a.code
  `)
  const cash = [...accounts]
  const empty = {
    ...range,
    grain,
    opening: '0',
    buckets: [],
    inflow: '0',
    outflow: '0',
    net: '0',
    closing: '0',
    accounts: [],
  }
  if (cash.length === 0) return empty

  const ids = sql.join(
    cash.map((account) => sql`${account.id}`),
    sql`, `,
  )
  const [openingRow] = await tx.execute<{ opening: string }>(sql`
    select coalesce(sum(case when l.side = 'debit' then l.amount else -l.amount end), 0)::text
      as opening
    from transaction_lines l
    where l.account_id in (${ids}) and l.posted_on < ${range.from}::date
  `)
  const opening = BigInt(openingRow?.opening ?? '0')

  const rows = await tx.execute<{ starts_on: string; inflow: string; outflow: string }>(sql`
    with buckets as (
      select generate_series(
        date_trunc(${grain}, ${range.from}::date),
        date_trunc(${grain}, ${range.to}::date),
        ${`1 ${grain}`}::interval
      )::date as starts_on
    ),
    movement as (
      select date_trunc(${grain}, l.posted_on)::date as starts_on,
        coalesce(sum(l.amount) filter (where l.side = 'debit'), 0) as inflow,
        coalesce(sum(l.amount) filter (where l.side = 'credit'), 0) as outflow
      from transaction_lines l
      where l.account_id in (${ids})
        and l.posted_on between ${range.from}::date and ${range.to}::date
      group by 1
    )
    select b.starts_on::text as starts_on,
      coalesce(m.inflow, 0)::text as inflow,
      coalesce(m.outflow, 0)::text as outflow
    from buckets b
    left join movement m on m.starts_on = b.starts_on
    order by b.starts_on
  `)

  let running = opening
  const buckets = [...rows].map((row) => {
    const net = BigInt(row.inflow) - BigInt(row.outflow)
    running += net
    return {
      startsOn: row.starts_on,
      inflow: row.inflow,
      outflow: row.outflow,
      net: net.toString(),
      closing: running.toString(),
    }
  })
  const sum = (pick: (bucket: CashFlowBucket) => string) =>
    buckets.reduce((total, bucket) => total + BigInt(pick(bucket)), 0n)
  const inflow = sum((bucket) => bucket.inflow)
  const outflow = sum((bucket) => bucket.outflow)
  return {
    ...range,
    grain,
    opening: opening.toString(),
    buckets,
    inflow: inflow.toString(),
    outflow: outflow.toString(),
    net: (inflow - outflow).toString(),
    closing: running.toString(),
    accounts: cash.map((account) => ({ code: account.code, name: account.name })),
  }
}
