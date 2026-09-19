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
/** Quantities are integer micros for the same reason money is minor units (ADR 0010). */
const micros = (name: string) => bigint(name, { mode: 'bigint' })

/** Created lazily inside the tenant's own transaction; RLS and grants live in the migration. */
export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey(),
  createdAt: instant('created_at').notNull().defaultNow(),
})

/** Procurement's projection of a party holding the `supplier` role (ADR 0040). */
export const suppliers = pgTable('suppliers', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  name: text('name').notNull(),
  email: text('email').notNull(),
  phone: text('phone').notNull(),
  address: text('address').notNull(),
  status: text('status').notNull(),
  createdAt: instant('created_at').notNull(),
  updatedAt: instant('updated_at').notNull(),
})

/** Procurement's projection of the catalogue: what an item is called, and whether it lives. */
export const catalogItems = pgTable(
  'catalog_items',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    itemId: uuid('item_id').notNull(),
    description: text('description').notNull(),
    active: boolean('active').notNull(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.itemId] })],
)

export const requisitions = pgTable('requisitions', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  requestedBy: text('requested_by').notNull(),
  warehouseId: uuid('warehouse_id').notNull(),
  neededBy: businessDate('needed_by').notNull(),
  justification: text('justification'),
  status: text('status').notNull(),
  submittedBy: text('submitted_by'),
  submittedAt: instant('submitted_at'),
  decidedBy: text('decided_by'),
  decidedAt: instant('decided_at'),
  decisionReason: text('decision_reason'),
  orderId: uuid('order_id'),
  closureReason: text('closure_reason'),
  version: integer('version').notNull(),
  createdAt: instant('created_at').notNull(),
  updatedAt: instant('updated_at').notNull(),
})

export const requisitionLines = pgTable(
  'requisition_lines',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    requisitionId: uuid('requisition_id').notNull(),
    lineId: uuid('line_id').notNull(),
    itemId: uuid('item_id').notNull(),
    description: text('description').notNull(),
    quantity: micros('quantity').notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.requisitionId, table.lineId] })],
)

export const quotations = pgTable('quotations', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  requisitionId: uuid('requisition_id').notNull(),
  supplierId: uuid('supplier_id').notNull(),
  reference: text('reference').notNull(),
  quotedOn: businessDate('quoted_on').notNull(),
  validUntil: businessDate('valid_until'),
  currency: text('currency').notNull(),
  tax: minorUnits('tax').notNull(),
  freight: minorUnits('freight').notNull(),
  otherCharges: minorUnits('other_charges').notNull(),
  discount: minorUnits('discount').notNull(),
  total: minorUnits('total').notNull(),
  paymentTermDays: jsonb('payment_term_days').$type<number[]>().notNull(),
  leadTimeDays: integer('lead_time_days').notNull(),
  notes: text('notes'),
  status: text('status').notNull(),
  recordedBy: text('recorded_by').notNull(),
  decidedAt: instant('decided_at'),
  createdAt: instant('created_at').notNull(),
  updatedAt: instant('updated_at').notNull(),
})

export const quotationLines = pgTable(
  'quotation_lines',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    quotationId: uuid('quotation_id').notNull(),
    lineId: uuid('line_id').notNull(),
    itemId: uuid('item_id').notNull(),
    description: text('description').notNull(),
    quantity: micros('quantity').notNull(),
    unitPrice: minorUnits('unit_price').notNull(),
    lineTotal: minorUnits('line_total').notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.quotationId, table.lineId] })],
)

export const orders = pgTable('orders', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  supplierId: uuid('supplier_id').notNull(),
  supplierName: text('supplier_name').notNull(),
  requisitionId: uuid('requisition_id'),
  quotationId: uuid('quotation_id'),
  warehouseId: uuid('warehouse_id').notNull(),
  currency: text('currency').notNull(),
  tax: minorUnits('tax').notNull(),
  freight: minorUnits('freight').notNull(),
  otherCharges: minorUnits('other_charges').notNull(),
  discount: minorUnits('discount').notNull(),
  total: minorUnits('total').notNull(),
  paymentTermDays: jsonb('payment_term_days').$type<number[]>().notNull(),
  issuedOn: businessDate('issued_on').notNull(),
  expectedOn: businessDate('expected_on').notNull(),
  notes: text('notes'),
  status: text('status').notNull(),
  approvalState: text('approval_state').notNull(),
  approvalRequestedBy: text('approval_requested_by'),
  approvalRequestedAt: instant('approval_requested_at'),
  approvalDecidedBy: text('approval_decided_by'),
  approvalDecidedAt: instant('approval_decided_at'),
  approvalReason: text('approval_reason'),
  closureReason: text('closure_reason'),
  receipts: integer('receipts').notNull().default(0),
  version: integer('version').notNull(),
  createdAt: instant('created_at').notNull(),
  updatedAt: instant('updated_at').notNull(),
})

export const orderLines = pgTable(
  'order_lines',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    orderId: uuid('order_id').notNull(),
    lineId: uuid('line_id').notNull(),
    itemId: uuid('item_id').notNull(),
    description: text('description').notNull(),
    quantity: micros('quantity').notNull(),
    unitPrice: minorUnits('unit_price').notNull(),
    lineTotal: minorUnits('line_total').notNull(),
    /** Cumulative across every delivery; the one thing about a committed line that moves. */
    received: micros('received').notNull().default(0n),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.orderId, table.lineId] })],
)

export const receipts = pgTable('receipts', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  orderId: uuid('order_id').notNull(),
  warehouseId: uuid('warehouse_id').notNull(),
  receivedOn: businessDate('received_on').notNull(),
  receivedBy: text('received_by').notNull(),
  currency: text('currency').notNull(),
  value: minorUnits('value').notNull(),
  notes: text('notes'),
  overrideReason: text('override_reason'),
  status: text('status').notNull(),
  returnedBy: text('returned_by'),
  returnedAt: instant('returned_at'),
  returnReason: text('return_reason'),
  createdAt: instant('created_at').notNull(),
})

export const receiptLines = pgTable(
  'receipt_lines',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    receiptId: uuid('receipt_id').notNull(),
    lineId: uuid('line_id').notNull(),
    itemId: uuid('item_id').notNull(),
    description: text('description').notNull(),
    quantity: micros('quantity').notNull(),
    unitPrice: minorUnits('unit_price').notNull(),
    lineTotal: minorUnits('line_total').notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.receiptId, table.lineId] })],
)

export const approvalPolicies = pgTable(
  'approval_policies',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    currency: text('currency').notNull(),
    threshold: minorUnits('threshold').notNull(),
    updatedBy: text('updated_by').notNull(),
    updatedAt: instant('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.currency] })],
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
