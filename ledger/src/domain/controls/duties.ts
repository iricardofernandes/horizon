/**
 * The rows of the segregation-of-duties matrix this module enforces (ADR 0062). The matrix
 * lives in contracts, which the domain may not import; a unit test holds the two equal.
 */
export const ENFORCED_PAIRS = [
  {
    id: 'ledger.entry',
    perform: 'ledger:entry:create',
    approve: 'ledger:entry:approve',
  },
] as const

export const APPROVE_ENTRY = 'ledger:entry:approve'

/** The approvals this module lends: the deciding side of each of its pairs. */
export const DELEGABLE_PERMISSIONS: readonly string[] = [
  ...new Set(ENFORCED_PAIRS.map((pair) => pair.approve)),
]
