import {
  bigint,
  boolean,
  date,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })
const minorUnits = (name: string) => bigint(name, { mode: 'bigint' })
const businessDate = (name: string) => date(name, { mode: 'string' })

/** Created lazily inside the tenant's own transaction; RLS and grants live in the migration. */
export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey(),
  createdAt: instant('created_at').notNull().defaultNow(),
})

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  parentId: uuid('parent_id'),
  postable: boolean('postable').notNull(),
  currency: text('currency').notNull(),
  active: boolean('active').notNull(),
  createdAt: instant('created_at').notNull(),
  updatedAt: instant('updated_at').notNull(),
})

export const transactions = pgTable('transactions', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  reference: text('reference').notNull(),
  postedOn: businessDate('posted_on').notNull(),
  period: text('period').notNull(),
  currency: text('currency').notNull(),
  total: minorUnits('total').notNull(),
  sourceType: text('source_type').notNull(),
  sourceId: uuid('source_id'),
  memo: text('memo'),
  status: text('status').notNull(),
  reverses: uuid('reverses'),
  reversedBy: uuid('reversed_by'),
  reversalReason: text('reversal_reason'),
  postedAt: instant('posted_at').notNull(),
  reversedAt: instant('reversed_at'),
})

export const transactionLines = pgTable(
  'transaction_lines',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    transactionId: uuid('transaction_id').notNull(),
    lineNumber: integer('line_number').notNull(),
    accountId: uuid('account_id').notNull(),
    accountCode: text('account_code').notNull(),
    side: text('side').notNull(),
    amount: minorUnits('amount').notNull(),
    currency: text('currency').notNull(),
    postedOn: businessDate('posted_on').notNull(),
    period: text('period').notNull(),
    memo: text('memo'),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.transactionId, table.lineNumber] })],
)

export const periods = pgTable('periods', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  period: text('period').notNull(),
  status: text('status').notNull(),
  closedBy: text('closed_by').notNull(),
  closedAt: instant('closed_at').notNull(),
  reopenedBy: text('reopened_by'),
  reopenedAt: instant('reopened_at'),
  reopenReason: text('reopen_reason'),
})

export const commandReceipts = pgTable(
  'command_receipts',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    idempotencyKey: text('idempotency_key').notNull(),
    command: text('command').notNull(),
    fingerprint: text('fingerprint').notNull(),
    response: jsonb('response').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.idempotencyKey] })],
)

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  sequence: bigint('sequence', { mode: 'number' }).notNull(),
  actor: text('actor').notNull(),
  subjectType: text('subject_type').notNull(),
  subjectId: uuid('subject_id').notNull(),
  action: text('action').notNull(),
  occurredAt: instant('occurred_at').notNull(),
  requestId: text('request_id'),
  traceId: text('trace_id'),
  details: jsonb('details').$type<Record<string, unknown>>().notNull(),
  previousHash: text('previous_hash').notNull(),
  hash: text('hash').notNull(),
})

export const outbox = pgTable('outbox', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  eventId: uuid('event_id').notNull().unique(),
  eventType: text('event_type').notNull(),
  eventVersion: smallint('event_version').notNull(),
  occurredAt: instant('occurred_at').notNull(),
  traceId: text('trace_id').notNull(),
  traceParent: text('trace_parent'),
  payload: jsonb('payload').notNull(),
  createdAt: instant('created_at').notNull().defaultNow(),
  dispatchedAt: instant('dispatched_at'),
  attempts: smallint('attempts').notNull().default(0),
  lastError: text('last_error'),
})
