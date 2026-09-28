/**
 * The rows of the segregation-of-duties matrix this module enforces (ADR 0062). The matrix
 * lives in contracts, which the domain may not import; a unit test holds the two equal.
 */
export const ENFORCED_PAIRS = [
  {
    id: 'treasury.transfer',
    perform: 'treasury:transfer:create',
    approve: 'treasury:transfer:approve',
  },
] as const

export const APPROVE_TRANSFER = 'treasury:transfer:approve'

/** The approvals this module lends: the deciding side of each of its pairs. */
export const DELEGABLE_PERMISSIONS: readonly string[] = [
  ...new Set(ENFORCED_PAIRS.map((pair) => pair.approve)),
]
