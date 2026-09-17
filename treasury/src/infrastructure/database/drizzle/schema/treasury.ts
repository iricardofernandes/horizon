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
  settlementId: uuid('settlement_id'),
  reverses: uuid('reverses'),
  counterparty: text('counterparty'),
  memo: text('memo'),
  reason: text('reason'),
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

export const statementImports = pgTable('statement_imports', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  accountId: uuid('account_id').notNull(),
  format: text('format').notNull(),
  fileName: text('file_name').notNull(),
  fileHash: text('file_hash').notNull(),
  lineCount: integer('line_count').notNull(),
  duplicateCount: integer('duplicate_count').notNull(),
  periodStart: businessDate('period_start'),
  periodEnd: businessDate('period_end'),
  closingBalance: minorUnits('closing_balance'),
  closingBalanceOn: businessDate('closing_balance_on'),
  importedBy: text('imported_by').notNull(),
  importedAt: instant('imported_at').notNull(),
})

export const statementLines = pgTable('statement_lines', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  accountId: uuid('account_id').notNull(),
  importId: uuid('import_id').notNull(),
  fingerprint: text('fingerprint').notNull(),
  postedOn: businessDate('posted_on').notNull(),
  amount: minorUnits('amount').notNull(),
  currency: text('currency').notNull(),
  bankReference: text('bank_reference'),
  documentId: text('document_id'),
  description: text('description').notNull(),
  counterparty: text('counterparty'),
  raw: jsonb('raw').$type<Record<string, string>>().notNull(),
})

export const reconciliations = pgTable('reconciliations', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  accountId: uuid('account_id').notNull(),
  kind: text('kind').notNull(),
  origin: text('origin').notNull(),
  suggestionKey: text('suggestion_key'),
  suggestionScore: smallint('suggestion_score'),
  corrected: boolean('corrected').notNull(),
  reason: text('reason'),
  status: text('status').notNull(),
  confirmedBy: text('confirmed_by').notNull(),
  confirmedAt: instant('confirmed_at').notNull(),
  undoneBy: text('undone_by'),
  undoneAt: instant('undone_at'),
  undoReason: text('undo_reason'),
})

export const reconciliationItems = pgTable('reconciliation_items', {
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  reconciliationId: uuid('reconciliation_id').notNull(),
  statementLineId: uuid('statement_line_id'),
  entryId: uuid('entry_id'),
  applied: minorUnits('applied').notNull(),
})

export const dismissedSuggestions = pgTable(
  'dismissed_suggestions',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    accountId: uuid('account_id').notNull(),
    suggestionKey: text('suggestion_key').notNull(),
    score: smallint('score').notNull(),
    dismissedBy: text('dismissed_by').notNull(),
    dismissedAt: instant('dismissed_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.accountId, table.suggestionKey] })],
)

export const reconciliationClosures = pgTable('reconciliation_closures', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  accountId: uuid('account_id').notNull(),
  through: businessDate('through').notNull(),
  closedBy: text('closed_by').notNull(),
  closedAt: instant('closed_at').notNull(),
  reopenedBy: text('reopened_by'),
  reopenedAt: instant('reopened_at'),
  reopenReason: text('reopen_reason'),
})

export const inbox = pgTable('inbox', {
  sourceModule: text('source_module').notNull(),
  eventId: uuid('event_id').notNull(),
  eventType: text('event_type').notNull(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  receivedAt: instant('received_at').notNull().defaultNow(),
})

export const settlementPostings = pgTable('settlement_postings', {
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  settlementId: uuid('settlement_id').notNull(),
  titleId: uuid('title_id').notNull(),
  accountId: uuid('account_id').notNull(),
  status: text('status').notNull(),
  entryId: uuid('entry_id'),
  reason: text('reason'),
  receivedAt: instant('received_at').notNull(),
})
