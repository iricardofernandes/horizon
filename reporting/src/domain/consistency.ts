/**
 * Consistency checks (ADR 0063, Phase 69): an owner's figures against the ledger accounts
 * that should hold the same amounts, and every module's audit chain. Pure: the figures come
 * in, the verdicts go out.
 */

export const CONSISTENCY_CHECKS = [
  'receivables-control',
  'payables-control',
  'cash-accounts',
  'inventory-accounts',
  'audit-chains',
] as const
export type ConsistencyCheckName = (typeof CONSISTENCY_CHECKS)[number]

export type ConsistencyOutcome = 'matched' | 'differences' | 'not-applicable' | 'unread'
export type ConsistencyRunOutcome = 'consistent' | 'inconsistent' | 'incomplete'

export interface ConsistencyDifference {
  readonly key: string
  readonly owner: string
  readonly ledger: string
}

export interface ConsistencyCheck {
  readonly check: ConsistencyCheckName
  readonly outcome: ConsistencyOutcome
  readonly compared: number
  readonly differences: readonly ConsistencyDifference[]
  readonly reason: string | null
}

/** Amounts per key (a currency), as decimal strings of minor units. */
export type Amounts = Readonly<Record<string, string>>

/** Sums `[key, amount]` pairs onto their keys. */
export function totalsOf(pairs: readonly (readonly [string, string])[]): Amounts {
  const totals = new Map<string, bigint>()
  for (const [key, amount] of pairs) totals.set(key, (totals.get(key) ?? 0n) + BigInt(amount))
  return Object.fromEntries([...totals].map(([key, value]) => [key, value.toString()]))
}

/**
 * Every key either side names, compared; a key one side lacks counts as zero there. A
 * currency the owner holds nothing in and the ledger holds nothing in is not a difference.
 */
export function compareAmounts(check: ConsistencyCheckName, owner: Amounts, ledger: Amounts) {
  const keys = [...new Set([...Object.keys(owner), ...Object.keys(ledger)])].sort()
  const differences = keys
    .map((key) => ({ key, owner: owner[key] ?? '0', ledger: ledger[key] ?? '0' }))
    .filter((pair) => BigInt(pair.owner) !== BigInt(pair.ledger))
  return {
    check,
    outcome: differences.length ? 'differences' : 'matched',
    compared: keys.length,
    differences,
    reason: null,
  } satisfies ConsistencyCheck
}

export function notApplicable(check: ConsistencyCheckName, reason: string): ConsistencyCheck {
  return { check, outcome: 'not-applicable', compared: 0, differences: [], reason }
}

export function unread(check: ConsistencyCheckName, reason: string): ConsistencyCheck {
  return { check, outcome: 'unread', compared: 0, differences: [], reason }
}

/** One module's chain after reading every page of its log. */
export interface ChainVerdict {
  readonly module: string
  readonly status: 'intact' | 'broken' | 'unread'
  readonly checked: number
  readonly broken: readonly number[]
}

/**
 * Every module's chain as one check. A broken chain is a difference whose key is the module
 * and whose figures are the rows checked and the first broken sequence; a module that could
 * not be read makes the check unread only when no chain is broken.
 */
export function chainsCheck(verdicts: readonly ChainVerdict[]): ConsistencyCheck {
  const broken = verdicts.filter((verdict) => verdict.status === 'broken')
  const silent = verdicts.filter((verdict) => verdict.status === 'unread')
  const differences = broken.map((verdict) => ({
    key: verdict.module,
    owner: String(verdict.checked),
    ledger: String(Math.min(...verdict.broken)),
  }))
  if (differences.length)
    return {
      check: 'audit-chains',
      outcome: 'differences',
      compared: verdicts.length - silent.length,
      differences,
      reason: `broken: ${broken.map((verdict) => `${verdict.module} at ${verdict.broken.join(' ')}`).join('; ')}`,
    }
  if (silent.length)
    return {
      ...unread('audit-chains', `not read: ${silent.map((verdict) => verdict.module).join(', ')}`),
      compared: verdicts.length - silent.length,
    }
  return {
    check: 'audit-chains',
    outcome: 'matched',
    compared: verdicts.length,
    differences: [],
    reason: null,
  }
}

/** Any difference makes the run inconsistent; otherwise anything unread leaves it incomplete. */
export function runOutcomeOf(checks: readonly ConsistencyCheck[]): ConsistencyRunOutcome {
  if (checks.some((check) => check.outcome === 'differences')) return 'inconsistent'
  if (checks.some((check) => check.outcome === 'unread')) return 'incomplete'
  return 'consistent'
}
