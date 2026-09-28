import { z } from 'zod'

import { instantSchema, uuidSchema } from '../common'
import { type ModuleName, permissionIdSchema } from '../roles'
import { problemDetailsSchema } from './problem'

/**
 * Segregation of duties, delegation and the audit read contract (ADR 0062, Phase 68).
 *
 * The matrix below is documentation and a test oracle, never a runtime service: each
 * module enforces its own rows in its own domain, from the actors it already records, and
 * a unit test in the module asserts that what it enforces is exactly what is declared here.
 */

/** Two duties the same person may never both hold on the same record. */
export interface DutyConflict {
  /** Stable name of the pair, `<module>.<subject>`; the refusal body carries it. */
  readonly id: string
  readonly module: ModuleName
  /** Doing the work: drafting, requesting, submitting, placing or closing it. */
  readonly perform: string
  /** Deciding it, either way: approving or rejecting. */
  readonly approve: string
  readonly description: string
}

export const SEGREGATION_OF_DUTIES: readonly DutyConflict[] = [
  {
    id: 'financial.payable',
    module: 'financial',
    perform: 'financial:payable:create',
    approve: 'financial:payable:approve',
    description: 'Whoever drafted a payable, or sent it for approval, cannot decide it.',
  },
  {
    id: 'procurement.requisition',
    module: 'procurement',
    perform: 'procurement:requisition:create',
    approve: 'procurement:requisition:approve',
    description: 'Whoever requested or submitted a requisition cannot decide it.',
  },
  {
    id: 'procurement.order',
    module: 'procurement',
    perform: 'procurement:order:create',
    approve: 'procurement:order:approve',
    description: 'Whoever placed a purchase order cannot decide it.',
  },
  {
    id: 'procurement.requisition-order',
    module: 'procurement',
    perform: 'procurement:requisition:create',
    approve: 'procurement:order:approve',
    description:
      'Whoever requested or submitted a requisition cannot decide the order made from it.',
  },
  {
    id: 'inventory.adjustment',
    module: 'inventory',
    perform: 'inventory:adjustment:create',
    approve: 'inventory:adjustment:approve',
    description: 'Whoever asked for a stock adjustment cannot decide it.',
  },
  {
    id: 'inventory.count',
    module: 'inventory',
    perform: 'inventory:count:close',
    approve: 'inventory:count:approve',
    description: 'Whoever closed a stock count cannot decide its differences.',
  },
  {
    id: 'ledger.entry',
    module: 'ledger',
    perform: 'ledger:entry:create',
    approve: 'ledger:entry:approve',
    description: 'Whoever wrote a manual journal entry cannot decide it.',
  },
  {
    id: 'treasury.transfer',
    module: 'treasury',
    perform: 'treasury:transfer:create',
    approve: 'treasury:transfer:approve',
    description: 'Whoever asked for a transfer between accounts cannot decide it.',
  },
]

/** The approvals a module may lend: the deciding side of each of its pairs. */
export function delegablePermissions(module: ModuleName): string[] {
  return [
    ...new Set(
      SEGREGATION_OF_DUTIES.filter((pair) => pair.module === module).map((pair) => pair.approve),
    ),
  ]
}

/** The pairs a module enforces. */
export function dutyConflictsOf(module: ModuleName): DutyConflict[] {
  return SEGREGATION_OF_DUTIES.filter((pair) => pair.module === module)
}

export const SEGREGATION_OF_DUTIES_CODE = 'segregation-of-duties'
export const SEGREGATION_OF_DUTIES_TYPE = 'https://horizon.dev/problems/segregation-of-duties'

/** The one answer every module gives when a pair is refused: `403`, with the pair named. */
export const segregationOfDutiesProblemSchema = problemDetailsSchema.extend({
  type: z.literal(SEGREGATION_OF_DUTIES_TYPE),
  status: z.literal(403),
  code: z.literal(SEGREGATION_OF_DUTIES_CODE),
  pair: z.string().min(1),
})

export type SegregationOfDutiesProblem = z.infer<typeof segregationOfDutiesProblemSchema>

/** A delegation lasts at most this long; a longer absence is a role change. */
export const DELEGATION_MAX_DAYS = 90

/**
 * `POST /<module>/delegations`. The caller lends an approval they hold through their own
 * role; the delegate needs only a role in the module, which their own token proves each time.
 */
export const grantDelegationSchema = z
  .object({
    permission: permissionIdSchema,
    delegateId: z.string().min(1).max(200),
    startsAt: instantSchema,
    endsAt: instantSchema,
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict()

export type GrantDelegation = z.infer<typeof grantDelegationSchema>

export const DELEGATION_STATES = ['scheduled', 'active', 'ended', 'revoked'] as const

export const delegationSchema = z
  .object({
    id: uuidSchema,
    permission: permissionIdSchema,
    delegatorId: z.string().min(1),
    delegateId: z.string().min(1),
    startsAt: instantSchema,
    endsAt: instantSchema,
    reason: z.string().nullable(),
    status: z.enum(DELEGATION_STATES),
    createdAt: instantSchema,
    revokedAt: instantSchema.nullable(),
    revokedBy: z.string().nullable(),
  })
  .strict()

export type Delegation = z.infer<typeof delegationSchema>

/** How many entries one page of an audit log holds, at most. */
export const AUDIT_PAGE_MAX = 200

/**
 * `GET /<module>/audit`: newest first, filtered by who, what, which record and when. The
 * cursor is the sequence of the last entry of the previous page.
 */
export const auditQuerySchema = z
  .object({
    actor: z.string().min(1).max(200).optional(),
    action: z.string().min(1).max(200).optional(),
    subjectType: z.string().min(1).max(100).optional(),
    subjectId: z.string().min(1).max(200).optional(),
    from: instantSchema.optional(),
    to: instantSchema.optional(),
    cursor: z
      .string()
      .regex(/^\d{1,18}$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(AUDIT_PAGE_MAX).default(50),
  })
  .strict()

export type AuditQuery = z.infer<typeof auditQuerySchema>

export const auditEntrySchema = z
  .object({
    sequence: z.number().int().positive(),
    occurredAt: instantSchema,
    actor: z.string(),
    action: z.string(),
    subjectType: z.string(),
    subjectId: z.string(),
    requestId: z.string().nullable(),
    traceId: z.string().nullable(),
    /** What the module recorded; `null` when it is sealed (an encrypted personal diff). */
    details: z.record(z.string(), z.unknown()).nullable(),
    sealed: z.boolean().optional(),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()

export type AuditEntry = z.infer<typeof auditEntrySchema>

/**
 * The chain's verdict on one page: each row's hash recomputed from its own fields, and
 * linked to its predecessor and its successor. A changed, deleted or re-hashed row shows.
 */
export const auditChainSchema = z
  .object({
    status: z.enum(['intact', 'broken']),
    checked: z.number().int().nonnegative(),
    broken: z.array(z.number().int().positive()),
  })
  .strict()

export type AuditChain = z.infer<typeof auditChainSchema>

export const auditPageSchema = z
  .object({
    data: z.array(auditEntrySchema),
    page: z.object({ nextCursor: z.string().optional(), hasMore: z.boolean() }).strict(),
    chain: auditChainSchema,
  })
  .strict()

export type AuditPage = z.infer<typeof auditPageSchema>
