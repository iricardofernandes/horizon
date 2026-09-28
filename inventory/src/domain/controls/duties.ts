/**
 * The rows of the segregation-of-duties matrix this module enforces (ADR 0062). The matrix
 * lives in contracts, which the domain may not import; a unit test holds the two equal.
 */
export const ENFORCED_PAIRS = [
  {
    id: 'inventory.adjustment',
    perform: 'inventory:adjustment:create',
    approve: 'inventory:adjustment:approve',
  },
  {
    id: 'inventory.count',
    perform: 'inventory:count:close',
    approve: 'inventory:count:approve',
  },
] as const

export const APPROVE_ADJUSTMENT = 'inventory:adjustment:approve'
export const APPROVE_COUNT = 'inventory:count:approve'

/** The approvals this module lends: the deciding side of each of its pairs. */
export const DELEGABLE_PERMISSIONS: readonly string[] = [
  ...new Set(ENFORCED_PAIRS.map((pair) => pair.approve)),
]
