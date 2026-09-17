import { sql } from 'drizzle-orm'
import type { Transaction } from './treasury-store'

const signed = sql.raw("case when e.direction = 'inflow' then e.amount else -e.amount end")

export interface AccountBalances {
  readonly id: string
  readonly kind: string
  readonly name: string
  readonly currency: string
  readonly bankCode: string | null
  readonly branch: string | null
  readonly accountNumber: string | null
  readonly openedOn: string
  readonly active: boolean
  /**
   * What the ERP journal adds up to through `asOf`. Never the bank's live balance: an
   * imported statement balance arrives with reconciliation (Phase E).
   */
  readonly bookBalance: string
  /** Including entries dated after `asOf`: scheduled movements already recorded. */
  readonly projectedBalance: string
  /** The part of the book balance a person has matched to bank lines. */
  readonly reconciledBalance: string
  /** The balance the bank last reported in an imported statement, and its date. */
  readonly statementBalance: string | null
  readonly statementBalanceOn: string | null
  readonly lastValueOn: string | null
  readonly asOf: string
}

type BalanceRow = {
  id: string
  kind: string
  name: string
  currency: string
  bank_code: string | null
  branch: string | null
  account_number: string | null
  opened_on: string
  active: boolean
  book: string
  projected: string
  reconciled: string
  last_value_on: string | null
  statement: string | null
  statement_on: string | null
}

function presentBalances(row: BalanceRow, asOf: string): AccountBalances {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    currency: row.currency,
    bankCode: row.bank_code,
    branch: row.branch,
    accountNumber: row.account_number,
    openedOn: row.opened_on,
    active: row.active,
    bookBalance: row.book,
    projectedBalance: row.projected,
    reconciledBalance: row.reconciled,
    statementBalance: row.statement,
    statementBalanceOn: row.statement_on,
    lastValueOn: row.last_value_on,
    asOf,
  }
}

function balancesQuery(asOf: string, accountId?: string) {
  return sql`
    select a.id, a.kind, a.name, a.currency, a.bank_code, a.branch, a.account_number,
      a.opened_on::text as opened_on, a.active,
      coalesce(sum(${signed}) filter (where e.value_on <= ${asOf}::date), 0)::text as book,
      coalesce(sum(${signed}), 0)::text as projected,
      max(e.value_on) filter (where e.value_on <= ${asOf}::date)::text as last_value_on,
      (select coalesce(sum(i.applied), 0) from reconciliation_items i
        join reconciliations r on r.tenant_id = i.tenant_id and r.id = i.reconciliation_id
        join journal_entries j on j.tenant_id = i.tenant_id and j.id = i.entry_id
        where r.status = 'active' and j.account_id = a.id and j.value_on <= ${asOf}::date)::text as reconciled,
      (select s.closing_balance::text from statement_imports s
        where s.account_id = a.id and s.closing_balance_on <= ${asOf}::date
        order by s.closing_balance_on desc, s.imported_at desc limit 1) as statement,
      (select s.closing_balance_on::text from statement_imports s
        where s.account_id = a.id and s.closing_balance_on <= ${asOf}::date
        order by s.closing_balance_on desc, s.imported_at desc limit 1) as statement_on
    from accounts a
    left join journal_entries e on e.tenant_id = a.tenant_id and e.account_id = a.id
    ${accountId ? sql`where a.id = ${accountId}` : sql``}
    group by a.id
    order by a.active desc, a.name`
}

export async function listAccounts(tx: Transaction, asOf: string): Promise<AccountBalances[]> {
  const rows = (await tx.execute(balancesQuery(asOf))) as unknown as BalanceRow[]
  return rows.map((row) => presentBalances(row, asOf))
}

export async function accountBalances(
  tx: Transaction,
  accountId: string,
  asOf: string,
): Promise<AccountBalances | null> {
  const [row] = (await tx.execute(balancesQuery(asOf, accountId))) as unknown as BalanceRow[]
  return row ? presentBalances(row, asOf) : null
}

export interface StatementLine {
  readonly id: string
  readonly direction: string
  readonly amount: string
  readonly valueOn: string
  readonly source: string
  readonly transferId: string | null
  readonly reverses: string | null
  readonly reversedBy: string | null
  readonly counterparty: string | null
  readonly memo: string | null
  readonly reason: string | null
  readonly recordedAt: Date
  /** The balance right after this line, in value-date order. */
  readonly runningBalance: string
}

/**
 * An account statement between two value dates. The opening balance is everything dated
 * before `from`, so a backdated entry shifts every later running balance consistently.
 */
export async function accountStatement(
  tx: Transaction,
  accountId: string,
  range: { from: string; to: string; limit: number; offset: number },
): Promise<{
  openingBalance: string
  closingBalance: string
  total: number
  lines: StatementLine[]
}> {
  const [totals] = (await tx.execute(sql`
    select
      coalesce(sum(${signed}) filter (where e.value_on < ${range.from}::date), 0)::text as opening,
      coalesce(sum(${signed}) filter (where e.value_on <= ${range.to}::date), 0)::text as closing,
      count(*) filter (where e.value_on between ${range.from}::date and ${range.to}::date)::int as total
    from journal_entries e where e.account_id = ${accountId}`)) as unknown as {
    opening: string
    closing: string
    total: number
  }[]
  const rows = (await tx.execute(sql`
    select e.id, e.direction, e.amount::text as amount, e.value_on::text as value_on, e.source,
      e.transfer_id, e.reverses, r.id as reversed_by, e.counterparty, e.memo, e.reason, e.recorded_at,
      (${totals?.opening ?? '0'}::bigint + sum(${signed}) over (
        order by e.value_on, e.recorded_at, e.id rows unbounded preceding
      ))::text as running_balance
    from journal_entries e
    left join journal_entries r on r.tenant_id = e.tenant_id and r.reverses = e.id
    where e.account_id = ${accountId}
      and e.value_on between ${range.from}::date and ${range.to}::date
    order by e.value_on, e.recorded_at, e.id
    limit ${range.limit} offset ${range.offset}`)) as unknown as Record<string, unknown>[]
  return {
    openingBalance: totals?.opening ?? '0',
    closingBalance: totals?.closing ?? '0',
    total: totals?.total ?? 0,
    lines: rows.map((row) => ({
      id: String(row.id),
      direction: String(row.direction),
      amount: String(row.amount),
      valueOn: String(row.value_on),
      source: String(row.source),
      transferId: (row.transfer_id as string | null) ?? null,
      reverses: (row.reverses as string | null) ?? null,
      reversedBy: (row.reversed_by as string | null) ?? null,
      counterparty: (row.counterparty as string | null) ?? null,
      memo: (row.memo as string | null) ?? null,
      reason: (row.reason as string | null) ?? null,
      recordedAt: new Date(String(row.recorded_at)),
      runningBalance: String(row.running_balance),
    })),
  }
}

/** The balance at the end of every day in the range, gaps included. */
export async function balanceTimeline(
  tx: Transaction,
  accountId: string,
  range: { from: string; to: string },
): Promise<{ day: string; balance: string }[]> {
  const rows = (await tx.execute(sql`
    select d::date::text as day,
      (select coalesce(sum(${signed}), 0) from journal_entries e
        where e.account_id = ${accountId} and e.value_on <= d::date)::text as balance
    from generate_series(${range.from}::date, ${range.to}::date, interval '1 day') d
    order by d`)) as unknown as { day: string; balance: string }[]
  return rows
}

export interface TransferRow {
  readonly id: string
  readonly fromAccountId: string
  readonly fromAccountName: string
  readonly toAccountId: string
  readonly toAccountName: string
  readonly amount: string
  readonly fee: string | null
  readonly currency: string
  readonly valueOn: string
  readonly memo: string | null
  readonly status: string
  readonly postedAt: Date
  readonly cancellationReason: string | null
}

export async function listTransfers(tx: Transaction, limit: number): Promise<TransferRow[]> {
  const rows = (await tx.execute(sql`
    select t.id, t.from_account_id, f.name as from_name, t.to_account_id, d.name as to_name,
      t.amount::text as amount, t.fee::text as fee, t.currency, t.value_on::text as value_on,
      t.memo, t.status, t.posted_at, t.cancellation_reason
    from transfers t
    join accounts f on f.tenant_id = t.tenant_id and f.id = t.from_account_id
    join accounts d on d.tenant_id = t.tenant_id and d.id = t.to_account_id
    order by t.value_on desc, t.posted_at desc
    limit ${limit}`)) as unknown as Record<string, unknown>[]
  return rows.map((row) => ({
    id: String(row.id),
    fromAccountId: String(row.from_account_id),
    fromAccountName: String(row.from_name),
    toAccountId: String(row.to_account_id),
    toAccountName: String(row.to_name),
    amount: String(row.amount),
    fee: (row.fee as string | null) ?? null,
    currency: String(row.currency),
    valueOn: String(row.value_on),
    memo: (row.memo as string | null) ?? null,
    status: String(row.status),
    postedAt: new Date(String(row.posted_at)),
    cancellationReason: (row.cancellation_reason as string | null) ?? null,
  }))
}
