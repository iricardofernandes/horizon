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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { tenants } from './dimensions'

const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })
const minorUnits = (name: string) => bigint(name, { mode: 'bigint' })

/** What Financial knows about a party: enough to name it on a title, nothing more. */
export const partyProjection = pgTable(
  'party_projection',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    partyId: uuid('party_id').notNull(),
    legalName: text('legal_name'),
    roles: text('roles').array().notNull(),
    active: boolean('active').notNull(),
    erased: boolean('erased').notNull().default(false),
    updatedAt: instant('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.partyId] })],
)

export const titles = pgTable('titles', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  direction: text('direction').notNull(),
  originType: text('origin_type').notNull(),
  originOrderId: uuid('origin_order_id'),
  partyId: uuid('party_id').notNull(),
  documentNumber: text('document_number').notNull(),
  description: text('description'),
  currency: text('currency').notNull(),
  categoryId: uuid('category_id'),
  issuedOn: date('issued_on', { mode: 'string' }).notNull(),
  competenceOn: date('competence_on', { mode: 'string' }).notNull(),
  allocations: jsonb('allocations')
    .$type<{ dimensionId: string; basisPoints: number }[]>()
    .notNull(),
  status: text('status').notNull(),
  settlementState: text('settlement_state').notNull(),
  total: minorUnits('total').notNull(),
  outstanding: minorUnits('outstanding').notNull(),
  nextDueOn: date('next_due_on', { mode: 'string' }),
  postedAt: instant('posted_at'),
  closedAt: instant('closed_at'),
  closureReason: text('closure_reason'),
  createdAt: instant('created_at').notNull(),
  updatedAt: instant('updated_at').notNull(),
})

export const titleInstallments = pgTable(
  'title_installments',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    titleId: uuid('title_id').notNull(),
    number: smallint('number').notNull(),
    dueOn: date('due_on', { mode: 'string' }).notNull(),
    amount: minorUnits('amount').notNull(),
    outstanding: minorUnits('outstanding').notNull(),
    state: text('state').notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.titleId, table.number] })],
)

export const titleSettlements = pgTable('title_settlements', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  titleId: uuid('title_id').notNull(),
  installmentNumber: smallint('installment_number').notNull(),
  settledOn: date('settled_on', { mode: 'string' }).notNull(),
  received: minorUnits('received').notNull(),
  discount: minorUnits('discount').notNull(),
  interest: minorUnits('interest').notNull(),
  penalty: minorUnits('penalty').notNull(),
  paymentMethodId: uuid('payment_method_id'),
  recordedAt: instant('recorded_at').notNull(),
  reversedAt: instant('reversed_at'),
  reversalReason: text('reversal_reason'),
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
  (table) => [uniqueIndex('inbox_source_event_key').on(table.sourceModule, table.eventId)],
)
