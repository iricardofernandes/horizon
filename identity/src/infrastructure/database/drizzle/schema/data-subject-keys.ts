import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * One key per data subject, and the subject's id **is** the primary key — so there is no
 * lookup table to get out of step and no subject that can end up with two.
 *
 * `material IS NULL` is the erasure (ADR 0026). Nothing is deleted, because deleting the
 * row would lose the `erased_at` timestamp that proves erasure happened and when.
 *
 * In the Terraform definition this table is replaced by AWS KMS: the column holds a key
 * ARN instead of key material, and `destroy` schedules key deletion. The application sees
 * the same interface either way, which is what `DATA_SUBJECT_KEY_MODE` selects.
 *
 * This table has its own backup schedule and its own access audit, because losing a key
 * here is an unintentional, irreversible erasure.
 */
export const dataSubjectKeys = pgTable('data_subject_keys', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  material: text('material'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  erasedAt: timestamp('erased_at', { withTimezone: true, mode: 'date' }),
})
