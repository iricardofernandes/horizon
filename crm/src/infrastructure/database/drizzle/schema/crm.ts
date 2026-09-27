import {
  bigint,
  boolean,
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
