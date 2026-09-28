import {
  bigint,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

const instant = (name: string) => timestamp(name, { withTimezone: true })

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey(),
  createdAt: instant('created_at').defaultNow().notNull(),
})

export const ownerKeys = pgTable(
  'owner_keys',
  {
    tenantId: uuid('tenant_id').notNull(),
    ownerType: text('owner_type').notNull(),
    ownerId: text('owner_id').notNull(),
    wrappedKey: text('wrapped_key'),
    erasedAt: instant('erased_at'),
    createdAt: instant('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.ownerType, table.ownerId] })],
)

export const attachments = pgTable('attachments', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  module: text('module').notNull(),
  recordType: text('record_type').notNull(),
  recordId: uuid('record_id').notNull(),
  fileName: text('file_name').notNull(),
  contentType: text('content_type').notNull(),
  size: integer('size').notNull(),
  sha256: text('sha256'),
  status: text('status').notNull(),
  deletionReason: text('deletion_reason'),
  finding: text('finding'),
  ownerType: text('owner_type').notNull(),
  ownerId: text('owner_id').notNull(),
  wrappedDataKey: text('wrapped_data_key'),
  objectKey: text('object_key'),
  idempotencyKey: text('idempotency_key').notNull(),
  fingerprint: text('fingerprint').notNull(),
  uploadedBy: text('uploaded_by').notNull(),
  createdAt: instant('created_at').notNull(),
  uploadedAt: instant('uploaded_at'),
  availableAt: instant('available_at'),
  expiresAt: instant('expires_at'),
  deletedAt: instant('deleted_at'),
  dueAt: instant('due_at'),
  scanAttempts: integer('scan_attempts').notNull(),
})

export const attachmentRemovals = pgTable('attachment_removals', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  attachmentId: uuid('attachment_id').notNull(),
  module: text('module').notNull(),
  recordType: text('record_type').notNull(),
  recordId: uuid('record_id').notNull(),
  reason: text('reason').notNull(),
  bytes: integer('bytes').notNull(),
  removedAt: instant('removed_at').notNull(),
})

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  sequence: bigint('sequence', { mode: 'number' }).notNull(),
  actor: text('actor').notNull(),
  subjectType: text('subject_type').notNull(),
  subjectId: text('subject_id').notNull(),
  action: text('action').notNull(),
  occurredAt: instant('occurred_at').notNull(),
  requestId: text('request_id'),
  traceId: text('trace_id'),
  details: jsonb('details').notNull(),
  previousHash: text('previous_hash').notNull(),
  hash: text('hash').notNull(),
})

export const outbox = pgTable('outbox', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  eventId: uuid('event_id').notNull(),
  eventType: text('event_type').notNull(),
  eventVersion: smallint('event_version').notNull(),
  occurredAt: instant('occurred_at').notNull(),
  traceId: text('trace_id').notNull(),
  traceParent: text('trace_parent'),
  payload: jsonb('payload').notNull(),
  createdAt: instant('created_at').defaultNow().notNull(),
  dispatchedAt: instant('dispatched_at'),
  attempts: smallint('attempts').notNull().default(0),
  lastError: text('last_error'),
})

export const inbox = pgTable(
  'inbox',
  {
    sourceModule: text('source_module').notNull(),
    eventId: uuid('event_id').notNull(),
    eventType: text('event_type').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    receivedAt: instant('received_at').defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.sourceModule, table.eventId] })],
)
