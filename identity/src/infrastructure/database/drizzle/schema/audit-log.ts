import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { tenants } from './tenants'

/**
 * Append-only, hash-chained per tenant (ADR 0025).
 *
 * Append-only is enforced **twice**, in `migrations/0001_tenant_isolation.sql`:
 * `REVOKE UPDATE, DELETE` from the application role, and a trigger that raises on either.
 * The second exists so that if the privileges are ever restored by mistake — a careless
 * `GRANT ALL`, a restored dump — the prohibition still holds. One mechanism would be a
 * single point of failure for the property the whole table exists to provide.
 *
 * `sequence` is per tenant and gapless, which is what lets the verifier walk a chain in
 * order and name the first broken link. The unique constraint on `(tenant_id, sequence)`
 * is what makes two concurrent writers claiming the same predecessor a failed transaction
 * rather than a forked chain.
 *
 * `before` and `after` hold the diff **encrypted under the data subject's key** when the
 * entry concerns one. That is what makes ADR 0025 and ADR 0026 compatible rather than
 * contradictory: the hash covers ciphertext, so destroying a key changes nothing that was
 * hashed and the chain still verifies after a lawful erasure.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    actorType: text('actor_type').notNull(),
    actorId: uuid('actor_id'),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    action: text('action').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    requestId: text('request_id'),
    traceId: text('trace_id'),
    sourceIp: text('source_ip'),
    before: jsonb('before').$type<Record<string, unknown> | null>(),
    after: jsonb('after').$type<Record<string, unknown> | null>(),
    /** Which members were removed before hashing — and it is inside the hash (ADR 0025). */
    redacted: jsonb('redacted').$type<string[]>().notNull().default([]),
    previousHash: text('previous_hash').notNull(),
    hash: text('hash').notNull(),
  },
  (table) => [
    uniqueIndex('audit_log_tenant_sequence_key').on(table.tenantId, table.sequence),
    index('audit_log_tenant_subject_idx').on(table.tenantId, table.subjectType, table.subjectId),
  ],
)
