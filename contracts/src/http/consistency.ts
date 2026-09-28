import { z } from 'zod'

import { instantSchema, uuidSchema } from '../common'

/**
 * Consistency checks (ADR 0063, Phase 69): figures an owner keeps compared with the ledger
 * accounts that should hold the same amount, and every module's audit chain. Reporting runs
 * them on a schedule and on request, and keeps each run.
 */
export const CONSISTENCY_CHECKS = [
  'receivables-control',
  'payables-control',
  'cash-accounts',
  'inventory-accounts',
  'audit-chains',
] as const

export const CONSISTENCY_OUTCOMES = ['matched', 'differences', 'not-applicable', 'unread'] as const

const figure = z.string().regex(/^-?\d+$/)

export const consistencyDifferenceSchema = z
  .object({ key: z.string(), owner: figure, ledger: figure })
  .strict()

export const consistencyCheckSchema = z
  .object({
    check: z.enum(CONSISTENCY_CHECKS),
    outcome: z.enum(CONSISTENCY_OUTCOMES),
    /** Per currency, or per module for the audit chains. */
    compared: z.number().int().nonnegative(),
    differences: z.array(consistencyDifferenceSchema),
    /** Why the check could not compare, when it could not. */
    reason: z.string().nullable(),
  })
  .strict()

export type ConsistencyCheck = z.infer<typeof consistencyCheckSchema>

export const consistencyRunSchema = z
  .object({
    runId: uuidSchema,
    trigger: z.enum(['scheduled', 'manual']),
    outcome: z.enum(['consistent', 'inconsistent', 'incomplete']),
    checks: z.array(consistencyCheckSchema),
    /** Ledger facts waiting for an account mapping when the run read the ledger. */
    pendingPostings: z.number().int().nonnegative().nullable(),
    startedBy: z.string(),
    startedAt: instantSchema,
    finishedAt: instantSchema,
  })
  .strict()

export type ConsistencyRun = z.infer<typeof consistencyRunSchema>
