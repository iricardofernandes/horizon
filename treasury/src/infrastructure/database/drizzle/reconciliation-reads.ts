import { sql } from 'drizzle-orm'
import {
  SUGGESTION_WINDOW_DAYS,
  type Suggestion,
  suggestMatches,
} from '@/domain/services/match-suggestions'
import { closuresRepository, reconciliationsRepository } from './reconciliation-store'
import type { Transaction } from './treasury-store'

type Row = Record<string, unknown>
const text = (value: unknown) => (value === null || value === undefined ? null : String(value))

function shift(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

export interface WorkspaceLine {
  readonly id: string
  readonly postedOn: string
  readonly amount: string
  readonly open: string
  readonly status: 'unmatched' | 'partial' | 'matched' | 'ignored'
  readonly bankReference: string | null
  readonly documentId: string | null
  readonly description: string
  readonly counterparty: string | null
}

export interface WorkspaceEntry {
  readonly id: string
  readonly valueOn: string
  readonly amount: string
  readonly open: string
  readonly status: 'unmatched' | 'partial' | 'matched'
  readonly source: string
  readonly counterparty: string | null
  readonly memo: string | null
}

/**
 * The period summary. Every group in force balances, so what the bank said in the period,
 * less what was ignored and what is still unmatched, equals what the books say, less what is
 * still unmatched on their side — up to `crossPeriod`, the part of matches whose other side
 * falls outside the period.
 */
export interface ReconciliationSummary {
  readonly bookOpening: string
  readonly bookClosing: string
  readonly statementTotal: string
  readonly ignoredTotal: string
  readonly unmatchedStatement: string
  readonly entryTotal: string
  readonly unmatchedEntries: string
  readonly crossPeriod: string
  readonly difference: string
}

const status = (amount: bigint, open: bigint, ignored: boolean) => {
  if (open === 0n) return ignored ? 'ignored' : 'matched'
  return open === (amount < 0n ? -amount : amount) ? 'unmatched' : 'partial'
}

async function lines(tx: Transaction, accountId: string, from: string, to: string) {
  const rows = (await tx.execute(sql`
    select l.id, l.posted_on::text as posted_on, l.amount::text as amount, l.bank_reference,
      l.document_id, l.description, l.counterparty,
      coalesce(sum(abs(i.applied)) filter (where r.kind = 'match'), 0)::text as matched,
      coalesce(sum(abs(i.applied)) filter (where r.kind = 'ignore'), 0)::text as ignored
    from statement_lines l
    left join reconciliation_items i on i.tenant_id = l.tenant_id and i.statement_line_id = l.id
    left join reconciliations r on r.tenant_id = i.tenant_id and r.id = i.reconciliation_id and r.status = 'active'
    where l.account_id = ${accountId} and l.posted_on between ${from}::date and ${to}::date
    group by l.id
    order by l.posted_on, l.id`)) as unknown as Row[]
  return rows.map((row) => {
    const amount = BigInt(String(row.amount))
    const matched = BigInt(String(row.matched))
    const ignored = BigInt(String(row.ignored))
    const size = amount < 0n ? -amount : amount
    const open = size - matched - ignored
    return {
      matched: amount < 0n ? -matched : matched,
      ignored: amount < 0n ? -ignored : ignored,
      line: {
        id: String(row.id),
        postedOn: String(row.posted_on),
        amount: amount.toString(),
        open: (amount < 0n ? -open : open).toString(),
        status: status(amount, open, ignored > 0n),
        bankReference: text(row.bank_reference),
        documentId: text(row.document_id),
        description: String(row.description),
        counterparty: text(row.counterparty),
      } satisfies WorkspaceLine,
    }
  })
}

async function entries(tx: Transaction, accountId: string, from: string, to: string) {
  const rows = (await tx.execute(sql`
    select e.id, e.value_on::text as value_on, e.source, e.counterparty, e.memo,
      ((case when e.direction = 'inflow' then 1 else -1 end) * e.amount)::text as amount,
      coalesce(sum(abs(i.applied)) filter (where r.id is not null), 0)::text as matched
    from journal_entries e
    left join reconciliation_items i on i.tenant_id = e.tenant_id and i.entry_id = e.id
    left join reconciliations r on r.tenant_id = i.tenant_id and r.id = i.reconciliation_id and r.status = 'active'
    where e.account_id = ${accountId} and e.value_on between ${from}::date and ${to}::date
    group by e.id
    order by e.value_on, e.recorded_at, e.id`)) as unknown as Row[]
  return rows.map((row) => {
    const amount = BigInt(String(row.amount))
    const matched = BigInt(String(row.matched))
    const size = amount < 0n ? -amount : amount
    const open = size - matched
    return {
      matched: amount < 0n ? -matched : matched,
      entry: {
        id: String(row.id),
        valueOn: String(row.value_on),
        amount: amount.toString(),
        open: (amount < 0n ? -open : open).toString(),
        status: status(amount, open, false) as WorkspaceEntry['status'],
        source: String(row.source),
        counterparty: text(row.counterparty),
        memo: text(row.memo),
      } satisfies WorkspaceEntry,
    }
  })
}

async function reconciliationsIn(tx: Transaction, accountId: string, from: string, to: string) {
  const rows = (await tx.execute(sql`
    select r.id, r.kind, r.origin, r.suggestion_score, r.corrected, r.reason, r.status,
      r.confirmed_by, r.confirmed_at, r.undone_at, r.undo_reason,
      json_agg(json_build_object(
        'kind', case when i.statement_line_id is null then 'entry' else 'statement' end,
        'id', coalesce(i.statement_line_id, i.entry_id),
        'applied', i.applied::text,
        'date', coalesce(l.posted_on, e.value_on)::text
      ) order by i.statement_line_id nulls last, i.entry_id) as items
    from reconciliations r
    join reconciliation_items i on i.tenant_id = r.tenant_id and i.reconciliation_id = r.id
    left join statement_lines l on l.tenant_id = i.tenant_id and l.id = i.statement_line_id
    left join journal_entries e on e.tenant_id = i.tenant_id and e.id = i.entry_id
    where r.account_id = ${accountId}
    group by r.id
    having bool_or(coalesce(l.posted_on, e.value_on) between ${from}::date and ${to}::date)
    order by r.confirmed_at desc
    limit 200`)) as unknown as Row[]
  return rows.map((row) => ({
    id: String(row.id),
    kind: String(row.kind),
    origin: String(row.origin),
    suggestionScore: row.suggestion_score === null ? null : Number(row.suggestion_score),
    corrected: Boolean(row.corrected),
    reason: text(row.reason),
    status: String(row.status),
    confirmedBy: String(row.confirmed_by),
    confirmedAt: new Date(String(row.confirmed_at)),
    undoneAt: row.undone_at ? new Date(String(row.undone_at)) : null,
    undoReason: text(row.undo_reason),
    items: row.items as { kind: string; id: string; applied: string; date: string }[],
  }))
}

async function bookBalances(tx: Transaction, accountId: string, from: string, to: string) {
  const [row] = (await tx.execute(sql`
    select
      coalesce(sum(case when direction = 'inflow' then amount else -amount end) filter (where value_on < ${from}::date), 0)::text as opening,
      coalesce(sum(case when direction = 'inflow' then amount else -amount end) filter (where value_on <= ${to}::date), 0)::text as closing
    from journal_entries where account_id = ${accountId}`)) as unknown as Row[]
  return {
    opening: BigInt(String(row?.opening ?? '0')),
    closing: BigInt(String(row?.closing ?? '0')),
  }
}

const sumOf = <T>(rows: readonly T[], pick: (row: T) => bigint) =>
  rows.reduce((total, row) => total + pick(row), 0n)

export async function reconciliationWorkspace(
  tx: Transaction,
  tenantId: string,
  accountId: string,
  range: { from: string; to: string },
) {
  const [lineRows, entryRows, groups, book] = await Promise.all([
    lines(tx, accountId, range.from, range.to),
    entries(tx, accountId, range.from, range.to),
    reconciliationsIn(tx, accountId, range.from, range.to),
    bookBalances(tx, accountId, range.from, range.to),
  ])
  const repository = reconciliationsRepository(tx, tenantId)
  const candidates = await repository.openCandidates(accountId, {
    from: shift(range.from, -SUGGESTION_WINDOW_DAYS),
    to: shift(range.to, SUGGESTION_WINDOW_DAYS),
  })
  const inRange = new Set(lineRows.map((row) => row.line.id))
  const suggestions: Suggestion[] = suggestMatches(
    candidates.lines,
    candidates.entries,
    await repository.dismissedKeys(accountId),
  ).filter((suggestion) => suggestion.statementLineIds.some((id) => inRange.has(id)))

  const statementTotal = sumOf(lineRows, (row) => BigInt(row.line.amount))
  const ignoredTotal = sumOf(lineRows, (row) => row.ignored)
  const unmatchedStatement = sumOf(lineRows, (row) => BigInt(row.line.open))
  const matchedStatement = sumOf(lineRows, (row) => row.matched)
  const entryTotal = sumOf(entryRows, (row) => BigInt(row.entry.amount))
  const unmatchedEntries = sumOf(entryRows, (row) => BigInt(row.entry.open))
  const matchedEntries = sumOf(entryRows, (row) => row.matched)
  const summary: ReconciliationSummary = {
    bookOpening: book.opening.toString(),
    bookClosing: book.closing.toString(),
    statementTotal: statementTotal.toString(),
    ignoredTotal: ignoredTotal.toString(),
    unmatchedStatement: unmatchedStatement.toString(),
    entryTotal: entryTotal.toString(),
    unmatchedEntries: unmatchedEntries.toString(),
    crossPeriod: (matchedEntries - matchedStatement).toString(),
    difference: (unmatchedStatement - unmatchedEntries).toString(),
  }
  return {
    ...range,
    closure: await closuresRepository(tx, tenantId).inForce(accountId),
    summary,
    lines: lineRows.map((row) => row.line),
    entries: entryRows.map((row) => row.entry),
    suggestions,
    reconciliations: groups,
  }
}

/**
 * How the matcher is doing: suggestions accepted as proposed, accepted after a correction, and
 * dismissed, beside manual matches. This is the evidence a later decision to auto-confirm
 * would need (ADR 0046).
 */
export async function reconciliationMetrics(tx: Transaction, accountId: string) {
  const [row] = (await tx.execute(sql`
    select
      count(*) filter (where kind = 'match' and origin = 'suggestion' and not corrected)::int as accepted,
      count(*) filter (where kind = 'match' and origin = 'suggestion' and corrected)::int as corrected,
      count(*) filter (where kind = 'match' and origin = 'manual')::int as manual,
      count(*) filter (where kind = 'ignore')::int as ignored,
      count(*) filter (where status = 'undone')::int as undone,
      (select count(*) from dismissed_suggestions d where d.account_id = ${accountId})::int as dismissed
    from reconciliations where account_id = ${accountId}`)) as unknown as {
    accepted: number
    corrected: number
    manual: number
    ignored: number
    undone: number
    dismissed: number
  }[]
  const counts = row ?? {
    accepted: 0,
    corrected: 0,
    manual: 0,
    ignored: 0,
    undone: 0,
    dismissed: 0,
  }
  const proposed = counts.accepted + counts.corrected + counts.dismissed
  return {
    ...counts,
    acceptanceRate: proposed === 0 ? null : counts.accepted / proposed,
    correctionRate: proposed === 0 ? null : counts.corrected / proposed,
  }
}
