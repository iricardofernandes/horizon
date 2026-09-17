import {
  bigint,
  boolean,
  date,
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
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  currency: text('currency').notNull(),
  bankCode: text('bank_code'),
  branch: text('branch'),
  accountNumber: text('account_number'),
  openedOn: businessDate('opened_on').notNull(),
  active: boolean('active').notNull(),
  createdAt: instant('created_at').notNull(),
  updatedAt: instant('updated_at').notNull(),
})

export const transfers = pgTable('transfers', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  fromAccountId: uuid('from_account_id').notNull(),
  toAccountId: uuid('to_account_id').notNull(),
  amount: minorUnits('amount').notNull(),
  fee: minorUnits('fee'),
  currency: text('currency').notNull(),
  valueOn: businessDate('value_on').notNull(),
  memo: text('memo'),
  status: text('status').notNull(),
  postedAt: instant('posted_at').notNull(),
  cancelledAt: instant('cancelled_at'),
  cancellationReason: text('cancellation_reason'),
})

export const journalEntries = pgTable('journal_entries', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  accountId: uuid('account_id').notNull(),
  direction: text('direction').notNull(),
  amount: minorUnits('amount').notNull(),
  currency: text('currency').notNull(),
  valueOn: businessDate('value_on').notNull(),
  source: text('source').notNull(),
  transferId: uuid('transfer_id'),
  reverses: uuid('reverses'),
  counterparty: text('counterparty'),
  memo: text('memo'),
  reason: text('reason'),
  reconciliationState: text('reconciliation_state').notNull().default('unreconciled'),
  recordedAt: instant('recorded_at').notNull(),
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
