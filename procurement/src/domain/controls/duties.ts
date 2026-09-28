/**
 * The rows of the segregation-of-duties matrix this module enforces (ADR 0062). The matrix
 * lives in contracts, which the domain may not import; a unit test holds the two equal.
 */
export const ENFORCED_PAIRS = [
  {
    id: 'procurement.requisition',
    perform: 'procurement:requisition:create',
    approve: 'procurement:requisition:approve',
  },
  {
    id: 'procurement.order',
    perform: 'procurement:order:create',
    approve: 'procurement:order:approve',
  },
  {
    id: 'procurement.requisition-order',
    perform: 'procurement:requisition:create',
    approve: 'procurement:order:approve',
  },
] as const

export const APPROVE_REQUISITION = 'procurement:requisition:approve'
export const APPROVE_ORDER = 'procurement:order:approve'

/** The approvals this module lends: the deciding side of each of its pairs. */
export const DELEGABLE_PERMISSIONS: readonly string[] = [
  ...new Set(ENFORCED_PAIRS.map((pair) => pair.approve)),
]
