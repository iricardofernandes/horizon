import { createHash } from 'node:crypto'
import { normalizedText } from '../entities/statement-line'

export interface CandidateLine {
  readonly id: string
  readonly date: string
  /** Signed minor units still unreconciled. */
  readonly open: bigint
  readonly description: string
  readonly counterparty: string | null
  readonly documentId: string | null
}

export interface CandidateEntry {
  readonly id: string
  readonly date: string
  readonly open: bigint
  readonly memo: string | null
  readonly counterparty: string | null
}

/** Why a suggestion was made, as data a screen translates (ADR 0044). */
export type Reason =
  | { readonly code: 'amount-exact' }
  | { readonly code: 'amount-sum'; readonly parts: number }
  | { readonly code: 'date'; readonly days: number }
  | { readonly code: 'document'; readonly document: string }
  | { readonly code: 'counterparty'; readonly percent: number }
  | { readonly code: 'text'; readonly percent: number }

export interface Suggestion {
  readonly key: string
  readonly shape: '1:1' | '1:N' | 'N:1'
  readonly statementLineIds: readonly string[]
  readonly entryIds: readonly string[]
  readonly score: number
  readonly reasons: readonly Reason[]
}

export const SUGGESTION_WINDOW_DAYS = 5
export const MINIMUM_SCORE = 45
const MAX_GROUP = 3
const MAX_GROUP_CANDIDATES = 12

const DAY = 86_400_000
const daysApart = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / DAY

function tokens(value: string | null): Set<string> {
  return new Set(
    normalizedText(value ?? '')
      .split(' ')
      .filter((token) => token.length > 2),
  )
}

function similarity(a: string | null, b: string | null): number {
  const left = tokens(a)
  const right = tokens(b)
  if (left.size === 0 || right.size === 0) return 0
  const shared = [...left].filter((token) => right.has(token)).length
  return shared / (left.size + right.size - shared)
}

/** A stable identity for a proposed grouping, so a person can accept or dismiss it later. */
export function suggestionKey(statementLineIds: readonly string[], entryIds: readonly string[]) {
  return createHash('sha256')
    .update(JSON.stringify([[...statementLineIds].sort(), [...entryIds].sort()]))
    .digest('hex')
    .slice(0, 32)
}

function evidence(lines: readonly CandidateLine[], entries: readonly CandidateEntry[]) {
  const reasons: Reason[] = []
  let score = 0
  const exact = lines.length === 1 && entries.length === 1
  if (exact) {
    reasons.push({ code: 'amount-exact' })
    score += 40
  } else {
    reasons.push({ code: 'amount-sum', parts: Math.max(lines.length, entries.length) })
    score += 30
  }
  const days = Math.max(
    ...lines.flatMap((line) => entries.map((entry) => daysApart(line.date, entry.date))),
  )
  reasons.push({ code: 'date', days })
  score += Math.max(0, 25 - 5 * days)
  const text = (entry: CandidateEntry) => [entry.memo, entry.counterparty].filter(Boolean).join(' ')
  const document = lines.find((line) => {
    const id = line.documentId?.replace(/^0+/, '')
    return id && entries.some((entry) => normalizedText(text(entry)).split(' ').includes(id))
  })?.documentId
  if (document) {
    reasons.push({ code: 'document', document })
    score += 15
  }
  const lineParty = lines.map((line) => line.counterparty ?? line.description).join(' ')
  const entryParty = entries.map((entry) => entry.counterparty).join(' ')
  const party = similarity(lineParty, entryParty)
  if (party >= 0.3) {
    reasons.push({ code: 'counterparty', percent: Math.round(party * 100) })
    score += Math.round(10 * party)
  }
  const words = similarity(
    lines.map((line) => line.description).join(' '),
    entries.map(text).join(' '),
  )
  if (words >= 0.3) {
    reasons.push({ code: 'text', percent: Math.round(words * 100) })
    score += Math.round(10 * words)
  }
  return { score: Math.min(score, 100), reasons }
}

function build(lines: readonly CandidateLine[], entries: readonly CandidateEntry[]): Suggestion {
  const statementLineIds = lines.map((line) => line.id)
  const entryIds = entries.map((entry) => entry.id)
  return {
    key: suggestionKey(statementLineIds, entryIds),
    shape: lines.length > 1 ? 'N:1' : entries.length > 1 ? '1:N' : '1:1',
    statementLineIds,
    entryIds,
    ...evidence(lines, entries),
  }
}

/** Every combination of 2..MAX_GROUP items, in input order. */
function groups<T>(items: readonly T[]): T[][] {
  const result: T[][] = []
  const walk = (start: number, current: T[]) => {
    if (current.length >= 2) result.push([...current])
    if (current.length === MAX_GROUP) return
    for (let index = start; index < items.length; index += 1)
      walk(index + 1, [...current, items[index] as T])
  }
  walk(0, [])
  return result
}

const near = (date: string, other: string) => daysApart(date, other) <= SUGGESTION_WINDOW_DAYS
const sum = (values: readonly { open: bigint }[]) =>
  values.reduce((total, value) => total + value.open, 0n)

function candidates(
  lines: readonly CandidateLine[],
  entries: readonly CandidateEntry[],
): Suggestion[] {
  const found: Suggestion[] = []
  for (const line of lines) {
    const close = entries.filter((entry) => near(line.date, entry.date))
    for (const entry of close.filter((candidate) => candidate.open === line.open))
      found.push(build([line], [entry]))
    const sameSign = close.filter((entry) => entry.open > 0n === line.open > 0n)
    for (const group of groups(sameSign.slice(0, MAX_GROUP_CANDIDATES)))
      if (sum(group) === line.open) found.push(build([line], group))
  }
  for (const entry of entries) {
    const close = lines.filter(
      (line) => near(line.date, entry.date) && line.open > 0n === entry.open > 0n,
    )
    for (const group of groups(close.slice(0, MAX_GROUP_CANDIDATES)))
      if (sum(group) === entry.open) found.push(build(group, [entry]))
  }
  return found
}

/**
 * Deterministic match suggestions: the same open lines and entries always produce the same
 * suggestions in the same order. Each carries a score and the reasons behind it; none is
 * ever confirmed without a person (ADR 0046). Suggestions never share an item: the best
 * scoring grouping claims its lines and entries first.
 */
export function suggestMatches(
  lines: readonly CandidateLine[],
  entries: readonly CandidateEntry[],
  dismissed: ReadonlySet<string> = new Set(),
): Suggestion[] {
  const ordered = candidates(
    [...lines].filter((line) => line.open !== 0n).sort((a, b) => a.id.localeCompare(b.id)),
    [...entries].filter((entry) => entry.open !== 0n).sort((a, b) => a.id.localeCompare(b.id)),
  )
    .filter((suggestion) => suggestion.score >= MINIMUM_SCORE && !dismissed.has(suggestion.key))
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
  const used = new Set<string>()
  const chosen: Suggestion[] = []
  for (const suggestion of ordered) {
    const ids = [...suggestion.statementLineIds, ...suggestion.entryIds]
    if (ids.some((id) => used.has(id))) continue
    for (const id of ids) used.add(id)
    chosen.push(suggestion)
  }
  return chosen
}
