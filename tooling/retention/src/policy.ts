import { z } from 'zod'

const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/)

/**
 * What retention removes, by table class (ADR 0063). Posted records, audit logs and event
 * history never appear here: a rule can only name delivery bookkeeping.
 */
export const ruleSchema = z
  .object({
    class: z.enum(['delivery-bookkeeping', 'command-receipts']),
    database: identifier,
    table: identifier,
    ageColumn: identifier,
    keepDays: z.number().int().min(7).max(3650),
  })
  .strict()

export type RetentionRule = z.infer<typeof ruleSchema>

/** Tables that are never removed by retention, whatever a policy says. */
export const NEVER_REMOVED = [
  'audit_log',
  'outbox',
  'event_journal',
  'fiscal_audit_entries',
  'fiscal_idempotency',
  'fiscal_linked_origin_idempotency',
  'fiscal_manual_origin_idempotency',
  'fiscal_service_origin_idempotency',
] as const

export const policySchema = z
  .object({
    rules: z.array(ruleSchema).min(1),
    batchSize: z.number().int().min(100).max(50_000).default(5000),
    /** What is only reported: work other workers own, and keys that must expire on their own. */
    reports: z
      .object({
        redisPrefixes: z.array(z.string().regex(/^[a-z][a-z0-9:-]*:$/)).default([]),
        overdueGraceMinutes: z.number().int().min(1).max(1440).default(60),
      })
      .strict(),
  })
  .strict()
  .refine(
    (policy) =>
      policy.rules.every((rule) => !(NEVER_REMOVED as readonly string[]).includes(rule.table)),
    'a rule names a table retention never removes',
  )

export type RetentionPolicy = z.infer<typeof policySchema>

export function cutoffOf(rule: RetentionRule, now: Date): Date {
  return new Date(now.getTime() - rule.keepDays * 86_400_000)
}
