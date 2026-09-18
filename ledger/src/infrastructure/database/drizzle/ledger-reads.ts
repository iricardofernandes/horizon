import { sql } from 'drizzle-orm'
import type { Transaction } from './ledger-store'

/**
 * A debit account grows on the debit side, a credit account on the credit side. Writing
 * it once here keeps every report using the same sign convention as the domain.
 */
const signedBalance = sql.raw(`case when a.type in ('asset', 'expense')
  then coalesce(debits, 0) - coalesce(credits, 0)
  else coalesce(credits, 0) - coalesce(debits, 0) end`)

export interface ChartAccount {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly type: string
  readonly parentId: string | null
  readonly postable: boolean
  readonly currency: string
  readonly active: boolean
  readonly depth: number
  /** The account's own balance through `asOf`, and its subtree's total. */
  readonly balance: string
  readonly rollUp: string
}

type ChartRow = {
  id: string
  code: string
  name: string
  type: string
  parent_id: string | null
  postable: boolean
  currency: string
  active: boolean
  depth: number
  balance: string
  roll_up: string
}

/**
 * The whole chart with balances through a date.
 *
 * A parent's `rollUp` is the sum of every postable account under it, found by code
 * prefix: `1.01` totals `1.01.001` and everything deeper. The tree is small and read
 * whole, so this is one query rather than a recursive walk.
 */
export async function chartOfAccounts(tx: Transaction, asOf: string): Promise<ChartAccount[]> {
  const rows = await tx.execute<ChartRow>(sql`
    with balances as (
      select l.account_id,
        sum(l.amount) filter (where l.side = 'debit') as debits,
        sum(l.amount) filter (where l.side = 'credit') as credits
      from transaction_lines l
      where l.posted_on <= ${asOf}::date
      group by l.account_id
    ),
    own as (
      select a.id, a.code, a.name, a.type, a.parent_id, a.postable, a.currency, a.active,
        array_length(string_to_array(a.code, '.'), 1) as depth,
        ${signedBalance} as balance
      from accounts a
      left join balances b on b.account_id = a.id
    )
    select o.id, o.code, o.name, o.type, o.parent_id, o.postable, o.currency, o.active, o.depth,
      o.balance::text as balance,
      (select coalesce(sum(d.balance), 0) from own d
        where d.id = o.id or d.code like o.code || '.%')::text as roll_up
    from own o
    order by o.code
  `)
  return [...rows].map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    parentId: row.parent_id,
    postable: row.postable,
    currency: row.currency,
    active: row.active,
    depth: row.depth,
    balance: row.balance,
    rollUp: row.roll_up,
  }))
}

export interface TrialBalanceRow {
  readonly accountId: string
  readonly code: string
  readonly name: string
  readonly type: string
  readonly currency: string
  readonly opening: string
  readonly debits: string
  readonly credits: string
  readonly closing: string
}

export interface TrialBalance {
  readonly from: string
  readonly to: string
  readonly rows: readonly TrialBalanceRow[]
  /** The two totals a trial balance exists to compare; they are equal or the ledger is wrong. */
  readonly totalDebits: string
  readonly totalCredits: string
}

type TrialRow = {
  account_id: string
  code: string
  name: string
  type: string
  currency: string
  opening: string
  debits: string
  credits: string
  closing: string
}

/**
 * Opening balance, the movement inside the range, and the closing balance, per postable
 * account. Accounts with no history and a zero opening balance are left out: a trial
 * balance is evidence, not an inventory of the chart.
 */
export async function trialBalance(
  tx: Transaction,
  range: { from: string; to: string },
): Promise<TrialBalance> {
  const rows = await tx.execute<TrialRow>(sql`
    with movement as (
      select l.account_id,
        sum(l.amount) filter (where l.side = 'debit' and l.posted_on < ${range.from}::date) as opening_debits,
        sum(l.amount) filter (where l.side = 'credit' and l.posted_on < ${range.from}::date) as opening_credits,
        sum(l.amount) filter (where l.side = 'debit' and l.posted_on between ${range.from}::date and ${range.to}::date) as debits,
        sum(l.amount) filter (where l.side = 'credit' and l.posted_on between ${range.from}::date and ${range.to}::date) as credits
      from transaction_lines l
      where l.posted_on <= ${range.to}::date
      group by l.account_id
    )
    select a.id as account_id, a.code, a.name, a.type, a.currency,
      (case when a.type in ('asset', 'expense')
        then coalesce(m.opening_debits, 0) - coalesce(m.opening_credits, 0)
        else coalesce(m.opening_credits, 0) - coalesce(m.opening_debits, 0) end)::text as opening,
      coalesce(m.debits, 0)::text as debits,
      coalesce(m.credits, 0)::text as credits,
      (case when a.type in ('asset', 'expense')
        then coalesce(m.opening_debits, 0) + coalesce(m.debits, 0)
           - coalesce(m.opening_credits, 0) - coalesce(m.credits, 0)
        else coalesce(m.opening_credits, 0) + coalesce(m.credits, 0)
           - coalesce(m.opening_debits, 0) - coalesce(m.debits, 0) end)::text as closing
    from accounts a
    join movement m on m.account_id = a.id
    order by a.code
  `)
  const presented = [...rows].map((row) => ({
    accountId: row.account_id,
    code: row.code,
    name: row.name,
    type: row.type,
    currency: row.currency,
    opening: row.opening,
    debits: row.debits,
    credits: row.credits,
    closing: row.closing,
  }))
  const total = (pick: (row: TrialBalanceRow) => string) =>
    presented.reduce((sum, row) => sum + BigInt(pick(row)), 0n).toString()
  return {
    ...range,
    rows: presented,
    totalDebits: total((row) => row.debits),
    totalCredits: total((row) => row.credits),
  }
}

export interface LedgerLine {
  readonly transactionId: string
  readonly lineNumber: number
  readonly reference: string
  readonly postedOn: string
  readonly side: string
  readonly amount: string
  readonly memo: string | null
  readonly status: string
  /** The fact this line accounts for, so a reader can follow it back out of the books. */
  readonly sourceType: string
  readonly sourceId: string | null
  /** The account balance right after this line, in the account's own sign convention. */
  readonly runningBalance: string
}

export interface AccountLedger {
  readonly accountId: string
  readonly code: string
  readonly name: string
  readonly currency: string
  readonly opening: string
  readonly closing: string
  readonly data: readonly LedgerLine[]
  readonly total: number
}

type LedgerRow = {
  transaction_id: string
  line_number: number
  reference: string
  posted_on: string
  side: string
  amount: string
  memo: string | null
  status: string
  source_type: string
  source_id: string | null
  running: string
}

/** One account's lines between two dates, each carrying the balance it left behind. */
export async function accountLedger(
  tx: Transaction,
  accountId: string,
  range: { from: string; to: string; limit: number; offset: number },
): Promise<AccountLedger | null> {
  const [account] = await tx.execute<{
    id: string
    code: string
    name: string
    currency: string
    type: string
    opening: string
  }>(sql`
    select a.id, a.code, a.name, a.currency, a.type,
      (case when a.type in ('asset', 'expense')
        then coalesce(sum(l.amount) filter (where l.side = 'debit'), 0)
           - coalesce(sum(l.amount) filter (where l.side = 'credit'), 0)
        else coalesce(sum(l.amount) filter (where l.side = 'credit'), 0)
           - coalesce(sum(l.amount) filter (where l.side = 'debit'), 0) end)::text as opening
    from accounts a
    left join transaction_lines l
      on l.account_id = a.id and l.posted_on < ${range.from}::date
    where a.id = ${accountId}
    group by a.id, a.code, a.name, a.currency, a.type
  `)
  if (!account) return null
  const effect = sql.raw(`case when a.type in ('asset', 'expense')
    then case when l.side = 'debit' then l.amount else -l.amount end
    else case when l.side = 'credit' then l.amount else -l.amount end end`)
  const rows = await tx.execute<LedgerRow>(sql`
    select l.transaction_id, l.line_number, t.reference, l.posted_on::text as posted_on,
      l.side, l.amount::text as amount, l.memo, t.status, t.source_type, t.source_id,
      (${account.opening}::numeric + sum(${effect}) over (
        order by l.posted_on, t.posted_at, l.transaction_id, l.line_number
        rows between unbounded preceding and current row
      ))::text as running
    from transaction_lines l
    join transactions t on t.tenant_id = l.tenant_id and t.id = l.transaction_id
    join accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id
    where l.account_id = ${accountId}
      and l.posted_on between ${range.from}::date and ${range.to}::date
    order by l.posted_on, t.posted_at, l.transaction_id, l.line_number
    limit ${range.limit} offset ${range.offset}
  `)
  const [counted] = await tx.execute<{ total: string }>(sql`
    select count(*)::text as total from transaction_lines l
    where l.account_id = ${accountId}
      and l.posted_on between ${range.from}::date and ${range.to}::date
  `)
  const data = [...rows].map((row) => ({
    transactionId: row.transaction_id,
    lineNumber: row.line_number,
    reference: row.reference,
    postedOn: row.posted_on,
    side: row.side,
    amount: row.amount,
    memo: row.memo,
    status: row.status,
    sourceType: row.source_type,
    sourceId: row.source_id,
    runningBalance: row.running,
  }))
  return {
    accountId: account.id,
    code: account.code,
    name: account.name,
    currency: account.currency,
    opening: account.opening,
    closing: data.at(-1)?.runningBalance ?? account.opening,
    data,
    total: Number(counted?.total ?? 0),
  }
}

export interface TransactionRow {
  readonly id: string
  readonly reference: string
  readonly postedOn: string
  readonly period: string
  readonly currency: string
  readonly total: string
  readonly status: string
  /** The business fact this accounts for: `manual`, or the kind and id another module reported. */
  readonly sourceType: string
  readonly sourceId: string | null
  readonly reverses: string | null
  readonly reversedBy: string | null
  readonly lineCount: number
}

type ListedRow = {
  id: string
  reference: string
  posted_on: string
  period: string
  currency: string
  total: string
  status: string
  source_type: string
  source_id: string | null
  reverses: string | null
  reversed_by: string | null
  line_count: number
}

export async function listTransactions(
  tx: Transaction,
  filter: { from: string; to: string; limit: number; offset: number },
): Promise<{ data: TransactionRow[]; total: number }> {
  const rows = await tx.execute<ListedRow>(sql`
    select t.id, t.reference, t.posted_on::text as posted_on, t.period, t.currency,
      t.total::text as total, t.status, t.source_type, t.source_id, t.reverses, t.reversed_by,
      (select count(*)::int from transaction_lines l
        where l.tenant_id = t.tenant_id and l.transaction_id = t.id) as line_count
    from transactions t
    where t.posted_on between ${filter.from}::date and ${filter.to}::date
    order by t.posted_on desc, t.posted_at desc, t.id desc
    limit ${filter.limit} offset ${filter.offset}
  `)
  const [counted] = await tx.execute<{ total: string }>(sql`
    select count(*)::text as total from transactions t
    where t.posted_on between ${filter.from}::date and ${filter.to}::date
  `)
  return {
    data: [...rows].map((row) => ({
      id: row.id,
      reference: row.reference,
      postedOn: row.posted_on,
      period: row.period,
      currency: row.currency,
      total: row.total,
      status: row.status,
      sourceType: row.source_type,
      sourceId: row.source_id,
      reverses: row.reverses,
      reversedBy: row.reversed_by,
      lineCount: row.line_count,
    })),
    total: Number(counted?.total ?? 0),
  }
}

export interface TransactionDetail extends TransactionRow {
  readonly memo: string | null
  readonly reversalReason: string | null
  readonly postedAt: string
  readonly lines: readonly {
    readonly lineNumber: number
    readonly accountId: string
    readonly accountCode: string
    readonly accountName: string
    readonly side: string
    readonly amount: string
    readonly memo: string | null
  }[]
}

export async function transactionDetail(
  tx: Transaction,
  id: string,
): Promise<TransactionDetail | null> {
  const [row] = await tx.execute<
    ListedRow & { memo: string | null; reversal_reason: string | null; posted_at: string }
  >(sql`
    select t.id, t.reference, t.posted_on::text as posted_on, t.period, t.currency,
      t.total::text as total, t.status, t.source_type, t.source_id, t.reverses, t.reversed_by,
      t.memo, t.reversal_reason, t.posted_at::text as posted_at,
      (select count(*)::int from transaction_lines l
        where l.tenant_id = t.tenant_id and l.transaction_id = t.id) as line_count
    from transactions t where t.id = ${id}
  `)
  if (!row) return null
  const lines = await tx.execute<{
    line_number: number
    account_id: string
    account_code: string
    account_name: string
    side: string
    amount: string
    memo: string | null
  }>(sql`
    select l.line_number, l.account_id, l.account_code, a.name as account_name,
      l.side, l.amount::text as amount, l.memo
    from transaction_lines l
    join accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id
    where l.transaction_id = ${id}
    order by l.line_number
  `)
  return {
    id: row.id,
    reference: row.reference,
    postedOn: row.posted_on,
    period: row.period,
    currency: row.currency,
    total: row.total,
    status: row.status,
    sourceType: row.source_type,
    sourceId: row.source_id,
    reverses: row.reverses,
    reversedBy: row.reversed_by,
    lineCount: row.line_count,
    memo: row.memo,
    reversalReason: row.reversal_reason,
    postedAt: row.posted_at,
    lines: [...lines].map((line) => ({
      lineNumber: line.line_number,
      accountId: line.account_id,
      accountCode: line.account_code,
      accountName: line.account_name,
      side: line.side,
      amount: line.amount,
      memo: line.memo,
    })),
  }
}

export interface PeriodRow {
  readonly period: string
  readonly status: string
  readonly closedBy: string
  readonly closedAt: string
  readonly reopenedBy: string | null
  readonly reopenReason: string | null
  readonly transactionCount: number
}

/** Every month the ledger has an opinion about, newest first. */
export async function listPeriods(tx: Transaction, limit: number): Promise<PeriodRow[]> {
  const rows = await tx.execute<{
    period: string
    status: string
    closed_by: string
    closed_at: string
    reopened_by: string | null
    reopen_reason: string | null
    transaction_count: number
  }>(sql`
    select p.period, p.status, p.closed_by, p.closed_at::text as closed_at,
      p.reopened_by, p.reopen_reason,
      (select count(*)::int from transactions t
        where t.tenant_id = p.tenant_id and t.period = p.period) as transaction_count
    from periods p
    order by p.period desc
    limit ${limit}
  `)
  return [...rows].map((row) => ({
    period: row.period,
    status: row.status,
    closedBy: row.closed_by,
    closedAt: row.closed_at,
    reopenedBy: row.reopened_by,
    reopenReason: row.reopen_reason,
    transactionCount: row.transaction_count,
  }))
}

export interface MappingRow {
  readonly role: string
  readonly key: string | null
  readonly accountId: string
  readonly accountCode: string
  readonly accountName: string
  readonly updatedBy: string
  readonly updatedAt: string
}

/** Which account plays each part, with the account's own name so the list reads. */
export async function listMappings(tx: Transaction): Promise<MappingRow[]> {
  const rows = await tx.execute<{
    role: string
    key: string
    account_id: string
    account_code: string
    account_name: string
    updated_by: string
    updated_at: string
  }>(sql`
    select m.role, m.key, m.account_id, m.account_code, a.name as account_name,
      m.updated_by, m.updated_at::text as updated_at
    from account_mappings m
    join accounts a on a.tenant_id = m.tenant_id and a.id = m.account_id
    order by m.role, m.key
  `)
  return [...rows].map((row) => ({
    role: row.role,
    key: row.key === '' ? null : row.key,
    accountId: row.account_id,
    accountCode: row.account_code,
    accountName: row.account_name,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  }))
}

export interface PendingFactRow {
  readonly kind: string
  readonly factId: string
  readonly reference: string
  readonly reason: string | null
  readonly receivedAt: string
}

/**
 * The facts the books are still missing, oldest first.
 *
 * This list is the module's own honesty check: while it is not empty, the trial balance is
 * complete for what it contains but does not yet contain everything that happened.
 */
export async function listPendingFacts(
  tx: Transaction,
  limit: number,
): Promise<{ data: PendingFactRow[]; total: number }> {
  const rows = await tx.execute<{
    kind: string
    fact_id: string
    reference: string
    reason: string | null
    received_at: string
  }>(sql`
    select f.kind, f.fact_id, f.reference, f.reason, f.received_at::text as received_at
    from posting_facts f
    where f.status = 'pending'
    order by f.received_at
    limit ${limit}
  `)
  const [counted] = await tx.execute<{ total: string }>(sql`
    select count(*)::text as total from posting_facts where status = 'pending'
  `)
  return {
    data: [...rows].map((row) => ({
      kind: row.kind,
      factId: row.fact_id,
      reference: row.reference,
      reason: row.reason,
      receivedAt: row.received_at,
    })),
    total: Number(counted?.total ?? 0),
  }
}
