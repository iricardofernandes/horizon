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

/** Created lazily inside the tenant's own transaction; RLS and grants live in the migration. */
export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey(),
  createdAt: instant('created_at').notNull().defaultNow(),
})

/** A party holding a CRM role (ADR 0057): the registry's facts plus CRM's own profile. */
export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  kind: text('kind'),
  legalName: text('legal_name'),
  tradeName: text('trade_name'),
  roles: text('roles').array().notNull(),
  documentType: text('document_type'),
  documentCountry: text('document_country'),
  partyActive: boolean('party_active').notNull(),
  ownerId: uuid('owner_id'),
  sourceId: uuid('source_id'),
  segment: text('segment'),
  tags: text('tags').array().notNull(),
  status: text('status').notNull(),
  createdAt: instant('created_at').notNull(),
  updatedAt: instant('updated_at').notNull(),
})

/** One key per contact. Destroying `material` is the erasure (ADR 0026). */
export const contactDataKeys = pgTable('contact_data_keys', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  material: text('material'),
  erasedAt: instant('erased_at'),
  createdAt: instant('created_at').notNull(),
})

export const contacts = pgTable('contacts', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  accountId: uuid('account_id').notNull(),
  nameCiphertext: text('name_ciphertext').notNull(),
  jobTitleCiphertext: text('job_title_ciphertext'),
  emailCiphertext: text('email_ciphertext'),
  phoneCiphertext: text('phone_ciphertext'),
  lawfulBasis: text('lawful_basis').notNull(),
  status: text('status').notNull(),
  createdAt: instant('created_at').notNull(),
  updatedAt: instant('updated_at').notNull(),
})

/** Workspace users as ids: who may own an account (Identity publishes no name or email). */
export const owners = pgTable(
  'owners',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    userId: uuid('user_id').notNull(),
    active: boolean('active').notNull(),
    registeredAt: instant('registered_at').notNull(),
    disabledAt: instant('disabled_at'),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.userId] })],
)

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
  subjectId: text('subject_id').notNull(),
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

export const inbox = pgTable(
  'inbox',
  {
    sourceModule: text('source_module').notNull(),
    eventId: uuid('event_id').notNull(),
    eventType: text('event_type').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    receivedAt: instant('received_at').notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.sourceModule, table.eventId] })],
)

/** A sequence of open stages; won and lost are the opportunity's outcome (Phase 56). */
export const pipelines = pgTable('pipelines', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  name: text('name').notNull(),
  archived: boolean('archived').notNull(),
  createdAt: instant('created_at').notNull(),
  updatedAt: instant('updated_at').notNull(),
})

export const pipelineStages = pgTable('pipeline_stages', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  pipelineId: uuid('pipeline_id').notNull(),
  name: text('name').notNull(),
  probabilityBps: integer('probability_bps').notNull(),
  position: integer('position').notNull(),
  archived: boolean('archived').notNull(),
})

/** Sources and loss reasons: archived, never deleted. */
export const listEntries = pgTable('list_entries', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  archived: boolean('archived').notNull(),
  createdAt: instant('created_at').notNull(),
  updatedAt: instant('updated_at').notNull(),
})

/** The latest fold of an opportunity's history; the history is the source of truth. */
export const opportunities = pgTable('opportunities', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  accountId: uuid('account_id').notNull(),
  title: text('title').notNull(),
  contactIds: uuid('contact_ids').array().notNull(),
  ownerId: uuid('owner_id').notNull(),
  sourceId: uuid('source_id'),
  expectedAmount: bigint('expected_amount', { mode: 'bigint' }).notNull(),
  currency: text('currency').notNull(),
  expectedCloseOn: date('expected_close_on', { mode: 'string' }).notNull(),
  pipelineId: uuid('pipeline_id').notNull(),
  stageId: uuid('stage_id').notNull(),
  probabilityBps: integer('probability_bps').notNull(),
  status: text('status').notNull(),
  lossReasonId: uuid('loss_reason_id'),
  lossNote: text('loss_note'),
  closedOn: date('closed_on', { mode: 'string' }),
  /** The accepted Sales quote it converted into (Phase 58). */
  convertedQuoteId: uuid('converted_quote_id'),
  convertedQuoteRoot: uuid('converted_quote_root'),
  convertedQuoteVersion: integer('converted_quote_version'),
  version: integer('version').notNull(),
  createdAt: instant('created_at').notNull(),
  updatedAt: instant('updated_at').notNull(),
})

/** Append-only: every fact of every opportunity, in order (Phase 56). */
export const opportunityEvents = pgTable(
  'opportunity_events',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    opportunityId: uuid('opportunity_id').notNull(),
    sequence: integer('sequence').notNull(),
    type: text('type').notNull(),
    fact: jsonb('fact').$type<Record<string, unknown>>().notNull(),
    actor: text('actor').notNull(),
    occurredAt: instant('occurred_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.opportunityId, table.sequence] })],
)

/** One key per account for the text of its records; destroying it is the erasure (Phase 57). */
export const accountDataKeys = pgTable('account_data_keys', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  material: text('material'),
  erasedAt: instant('erased_at'),
  createdAt: instant('created_at').notNull(),
})

/** A call, meeting, email or visit, attached to an account, a contact or an opportunity. */
export const activities = pgTable('activities', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  accountId: uuid('account_id').notNull(),
  subjectType: text('subject_type').notNull(),
  subjectId: uuid('subject_id').notNull(),
  kind: text('kind').notNull(),
  occurredAt: instant('occurred_at').notNull(),
  titleCiphertext: text('title_ciphertext').notNull(),
  summaryCiphertext: text('summary_ciphertext'),
  contactIds: uuid('contact_ids').array().notNull(),
  recordedBy: text('recorded_by').notNull(),
  version: integer('version').notNull(),
  createdAt: instant('created_at').notNull(),
  updatedAt: instant('updated_at').notNull(),
})

export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  accountId: uuid('account_id').notNull(),
  subjectType: text('subject_type').notNull(),
  subjectId: uuid('subject_id').notNull(),
  titleCiphertext: text('title_ciphertext').notNull(),
  assigneeId: uuid('assignee_id').notNull(),
  dueAt: instant('due_at').notNull(),
  remindAt: instant('remind_at'),
  remindedAt: instant('reminded_at'),
  status: text('status').notNull(),
  createdBy: text('created_by').notNull(),
  closedBy: text('closed_by'),
  closedAt: instant('closed_at'),
  version: integer('version').notNull(),
  createdAt: instant('created_at').notNull(),
  updatedAt: instant('updated_at').notNull(),
})

export const notes = pgTable('notes', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  accountId: uuid('account_id').notNull(),
  subjectType: text('subject_type').notNull(),
  subjectId: uuid('subject_id').notNull(),
  currentRevision: integer('current_revision').notNull(),
  createdAt: instant('created_at').notNull(),
  updatedAt: instant('updated_at').notNull(),
})

/** Append-only: every text a note ever had (Phase 57). */
export const noteRevisions = pgTable(
  'note_revisions',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    noteId: uuid('note_id').notNull(),
    revision: integer('revision').notNull(),
    bodyCiphertext: text('body_ciphertext').notNull(),
    author: text('author').notNull(),
    writtenAt: instant('written_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.noteId, table.revision] })],
)

/** The Sales quotes made for an opportunity, one row per offer (Phase 58). */
export const opportunityQuotes = pgTable(
  'opportunity_quotes',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    opportunityId: uuid('opportunity_id').notNull(),
    quoteRoot: uuid('quote_root').notNull(),
    quoteId: uuid('quote_id').notNull(),
    quoteVersion: integer('quote_version').notNull(),
    status: text('status').notNull(),
    totalAmount: bigint('total_amount', { mode: 'bigint' }),
    currency: text('currency'),
    seenAt: instant('seen_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.opportunityId, table.quoteRoot] })],
)
