import { createHash, randomBytes } from 'node:crypto'
import { context, propagation, trace } from '@opentelemetry/api'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { AuditRecord, AuditTrail, ProcurementScope } from '@/application/ports/unit-of-work'
import { canonicalJson } from '@/core/audit/canonical-json'
import type { Either } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import type { DomainEvent } from '@/core/events/domain-event'
import { GoodsReceipt, RECEIPT_STATUSES, type ReceiptStatus } from '@/domain/entities/goods-receipt'
import {
  APPROVAL_STATES,
  type ApprovalState,
  ORDER_STATUSES,
  type OrderStatus,
  PurchaseOrder,
} from '@/domain/entities/purchase-order'
import {
  PurchaseRequisition,
  REQUISITION_STATUSES,
  type RequisitionLine,
  type RequisitionStatus,
} from '@/domain/entities/purchase-requisition'
import { SUPPLIER_STATUSES, Supplier, type SupplierStatus } from '@/domain/entities/supplier'
import {
  QUOTATION_STATUSES,
  type QuotationStatus,
  SupplierQuotation,
} from '@/domain/entities/supplier-quotation'
import type { Charges, PricedLine } from '@/domain/services/pricing'
import {
  BusinessDate,
  Currency,
  DocumentNumber,
  LineDescription,
  Memo,
  Money,
  PartyName,
  PaymentTerms,
  Quantity,
  Reason,
} from '@/domain/value-objects/procurement-values'
import * as schema from './schema'

type Database = PostgresJsDatabase<typeof schema>
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

export const GENESIS_HASH = '0'.repeat(64)

export function restored<E, T>(result: Either<E, T>): T {
  if (result.isLeft())
    throw new Error('Invalid persisted procurement value', { cause: result.value })
  return result.value
}

function oneOf<T extends string>(allowed: readonly T[], value: string, what: string): T {
  if (!allowed.includes(value as T)) throw new Error(`Invalid persisted ${what}`)
  return value as T
}

function chargesOf(
  row: { tax: bigint; freight: bigint; otherCharges: bigint; discount: bigint },
  currency: Currency,
): Charges {
  return {
    tax: Money.of(row.tax, currency),
    freight: Money.of(row.freight, currency),
    otherCharges: Money.of(row.otherCharges, currency),
    discount: Money.of(row.discount, currency),
  }
}

function pricedLineOf(
  row: {
    lineId: string
    itemId: string
    description: string
    quantity: bigint
    unitPrice: bigint
    lineTotal: bigint
  },
  currency: Currency,
): PricedLine {
  return {
    lineId: row.lineId,
    itemId: row.itemId,
    description: restored(LineDescription.create(row.description)),
    quantity: Quantity.fromMicros(row.quantity),
    unitPrice: Money.of(row.unitPrice, currency),
    lineTotal: Money.of(row.lineTotal, currency),
  }
}

function mapSupplier(row: typeof schema.suppliers.$inferSelect): Supplier {
  return Supplier.rehydrate(
    {
      tenantId: row.tenantId,
      name: restored(PartyName.create(row.name)),
      email: row.email,
      phone: row.phone,
      address: row.address,
      status: oneOf<SupplierStatus>(SUPPLIER_STATUSES, row.status, 'supplier status'),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    new UniqueEntityID(row.id),
  )
}

function mapRequisition(
  row: typeof schema.requisitions.$inferSelect,
  lineRows: readonly (typeof schema.requisitionLines.$inferSelect)[],
): PurchaseRequisition {
  const lines: RequisitionLine[] = lineRows.map((line) => ({
    lineId: line.lineId,
    itemId: line.itemId,
    description: restored(LineDescription.create(line.description)),
    quantity: Quantity.fromMicros(line.quantity),
  }))
  return PurchaseRequisition.rehydrate(
    {
      tenantId: row.tenantId,
      requestedBy: row.requestedBy,
      warehouseId: row.warehouseId,
      neededBy: restored(BusinessDate.create(row.neededBy)),
      justification: restored(Memo.create(row.justification ?? undefined)),
      lines,
      status: oneOf<RequisitionStatus>(REQUISITION_STATUSES, row.status, 'requisition status'),
      submittedBy: row.submittedBy,
      submittedAt: row.submittedAt,
      decision:
        row.decidedBy && row.decidedAt
          ? {
              by: row.decidedBy,
              at: row.decidedAt,
              reason: row.decisionReason ? restored(Reason.create(row.decisionReason)) : null,
            }
          : null,
      orderId: row.orderId,
      closure: row.closureReason ? restored(Reason.create(row.closureReason)) : null,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    new UniqueEntityID(row.id),
  )
}

function mapQuotation(
  row: typeof schema.quotations.$inferSelect,
  lineRows: readonly (typeof schema.quotationLines.$inferSelect)[],
): SupplierQuotation {
  const currency = restored(Currency.create(row.currency))
  return SupplierQuotation.rehydrate(
    {
      tenantId: row.tenantId,
      requisitionId: row.requisitionId,
      supplierId: row.supplierId,
      reference: restored(DocumentNumber.create(row.reference)),
      quotedOn: restored(BusinessDate.create(row.quotedOn)),
      validUntil: row.validUntil ? restored(BusinessDate.create(row.validUntil)) : null,
      currency,
      lines: lineRows.map((line) => pricedLineOf(line, currency)),
      charges: chargesOf(row, currency),
      paymentTerms: restored(PaymentTerms.create(row.paymentTermDays)),
      leadTimeDays: row.leadTimeDays,
      notes: restored(Memo.create(row.notes ?? undefined)),
      status: oneOf<QuotationStatus>(QUOTATION_STATUSES, row.status, 'quotation status'),
      recordedBy: row.recordedBy,
      decidedAt: row.decidedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    new UniqueEntityID(row.id),
  )
}

function mapOrder(
  row: typeof schema.orders.$inferSelect,
  lineRows: readonly (typeof schema.orderLines.$inferSelect)[],
): PurchaseOrder {
  const currency = restored(Currency.create(row.currency))
  return PurchaseOrder.rehydrate(
    {
      tenantId: row.tenantId,
      supplier: {
        supplierId: row.supplierId,
        name: restored(PartyName.create(row.supplierName)),
      },
      requisitionId: row.requisitionId,
      quotationId: row.quotationId,
      warehouseId: row.warehouseId,
      currency,
      lines: lineRows.map((line) => pricedLineOf(line, currency)),
      charges: chargesOf(row, currency),
      paymentTerms: restored(PaymentTerms.create(row.paymentTermDays)),
      issuedOn: restored(BusinessDate.create(row.issuedOn)),
      expectedOn: restored(BusinessDate.create(row.expectedOn)),
      notes: restored(Memo.create(row.notes ?? undefined)),
      status: oneOf<OrderStatus>(ORDER_STATUSES, row.status, 'order status'),
      approval: {
        state: oneOf<ApprovalState>(APPROVAL_STATES, row.approvalState, 'approval state'),
        requestedBy: row.approvalRequestedBy,
        requestedAt: row.approvalRequestedAt,
        decidedBy: row.approvalDecidedBy,
        decidedAt: row.approvalDecidedAt,
        reason: row.approvalReason ? restored(Reason.create(row.approvalReason)) : null,
      },
      closure: row.closureReason ? restored(Reason.create(row.closureReason)) : null,
      received: lineRows
        .filter((line) => line.received > 0n)
        .map((line) => ({ lineId: line.lineId, quantity: Quantity.fromMicros(line.received) })),
      receipts: row.receipts,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    new UniqueEntityID(row.id),
  )
}

function mapReceipt(
  row: typeof schema.receipts.$inferSelect,
  lineRows: readonly (typeof schema.receiptLines.$inferSelect)[],
): GoodsReceipt {
  const currency = restored(Currency.create(row.currency))
  return GoodsReceipt.rehydrate(
    {
      tenantId: row.tenantId,
      orderId: row.orderId,
      warehouseId: row.warehouseId,
      receivedOn: restored(BusinessDate.create(row.receivedOn)),
      receivedBy: row.receivedBy,
      currency,
      lines: lineRows.map((line) => ({
        lineId: line.lineId,
        itemId: line.itemId,
        description: line.description,
        quantity: Quantity.fromMicros(line.quantity),
        unitPrice: Money.of(line.unitPrice, currency),
        lineTotal: Money.of(line.lineTotal, currency),
      })),
      value: Money.of(row.value, currency),
      notes: restored(Memo.create(row.notes ?? undefined)),
      overrideReason: row.overrideReason ? restored(Reason.create(row.overrideReason)) : null,
      status: oneOf<ReceiptStatus>(RECEIPT_STATUSES, row.status, 'receipt status'),
      returnedBy: row.returnedBy,
      returnedAt: row.returnedAt,
      returnReason: row.returnReason ? restored(Reason.create(row.returnReason)) : null,
      createdAt: row.createdAt,
    },
    new UniqueEntityID(row.id),
  )
}

async function publish(tx: Transaction, tenantId: string, event: DomainEvent): Promise<void> {
  if (event.tenantId !== tenantId) throw new Error('Event tenant does not match transaction')
  const id = new UniqueEntityID().toString()
  const carrier: Record<string, string> = {}
  propagation.inject(context.active(), carrier)
  await tx.insert(schema.outbox).values({
    id,
    eventId: id,
    tenantId,
    eventType: event.eventType,
    eventVersion: event.eventVersion,
    occurredAt: event.occurredAt,
    traceId:
      trace.getSpan(context.active())?.spanContext().traceId ?? randomBytes(16).toString('hex'),
    traceParent: carrier.traceparent ?? null,
    payload: { ...event.payloadOf() },
  })
}

export async function publishAll(
  tx: Transaction,
  tenantId: string,
  aggregate: { pullDomainEvents(): readonly DomainEvent[] },
) {
  for (const event of aggregate.pullDomainEvents()) await publish(tx, tenantId, event)
}

/** `hash = sha256(previous_hash || canonical_json(entry))`, as identity's chain (ADR 0025). */
export function auditHash(previousHash: string, entry: Record<string, unknown>): string {
  return createHash('sha256')
    .update(previousHash, 'utf8')
    .update(canonicalJson(entry), 'utf8')
    .digest('hex')
}

function auditTrail(tx: Transaction, tenantId: string): AuditTrail {
  return {
    append: async (record: AuditRecord) => {
      // A per-tenant transaction lock serializes chain appends, including the first link.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`procurement.audit:${tenantId}`}, 0))`,
      )
      const [last] = await tx
        .select({ sequence: schema.auditLog.sequence, hash: schema.auditLog.hash })
        .from(schema.auditLog)
        .orderBy(desc(schema.auditLog.sequence))
        .limit(1)
      const entry = {
        sequence: (last?.sequence ?? 0) + 1,
        tenantId,
        actor: record.actor,
        subjectType: record.subjectType,
        subjectId: record.subjectId,
        action: record.action,
        occurredAt: record.occurredAt,
        requestId: record.requestId,
        traceId: trace.getSpan(context.active())?.spanContext().traceId ?? null,
        details: JSON.parse(canonicalJson(record.details)) as Record<string, unknown>,
      }
      const previousHash = last?.hash ?? GENESIS_HASH
      await tx.insert(schema.auditLog).values({
        id: new UniqueEntityID().toString(),
        ...entry,
        previousHash,
        hash: auditHash(previousHash, entry),
      })
    },
  }
}

async function loadRequisition(
  tx: Transaction,
  row: typeof schema.requisitions.$inferSelect,
): Promise<PurchaseRequisition> {
  const lines = await tx
    .select()
    .from(schema.requisitionLines)
    .where(eq(schema.requisitionLines.requisitionId, row.id))
    .orderBy(asc(schema.requisitionLines.lineId))
  return mapRequisition(row, lines)
}

async function loadQuotation(
  tx: Transaction,
  row: typeof schema.quotations.$inferSelect,
): Promise<SupplierQuotation> {
  const lines = await tx
    .select()
    .from(schema.quotationLines)
    .where(eq(schema.quotationLines.quotationId, row.id))
    .orderBy(asc(schema.quotationLines.lineId))
  return mapQuotation(row, lines)
}

async function loadReceipt(
  tx: Transaction,
  row: typeof schema.receipts.$inferSelect,
): Promise<GoodsReceipt> {
  const lines = await tx
    .select()
    .from(schema.receiptLines)
    .where(eq(schema.receiptLines.receiptId, row.id))
    .orderBy(asc(schema.receiptLines.lineId))
  return mapReceipt(row, lines)
}

async function loadOrder(
  tx: Transaction,
  row: typeof schema.orders.$inferSelect,
): Promise<PurchaseOrder> {
  const lines = await tx
    .select()
    .from(schema.orderLines)
    .where(eq(schema.orderLines.orderId, row.id))
    .orderBy(asc(schema.orderLines.lineId))
  return mapOrder(row, lines)
}

export function makeScope(tx: Transaction, tenantId: string): ProcurementScope {
  const assertTenant = (actual: string) => {
    if (actual !== tenantId) throw new Error('Aggregate tenant does not match transaction')
  }
  return {
    tenantId,
    suppliers: {
      findById: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.suppliers)
          .where(eq(schema.suppliers.id, id))
          .limit(1)
        return row ? mapSupplier(row) : null
      },
      create: async (supplier) => {
        const row = supplier.toSnapshot()
        assertTenant(row.tenantId)
        await tx.insert(schema.suppliers).values(row).onConflictDoNothing()
      },
      save: async (supplier) => {
        const row = supplier.toSnapshot()
        assertTenant(row.tenantId)
        await tx
          .update(schema.suppliers)
          .set({
            name: row.name,
            email: row.email,
            phone: row.phone,
            address: row.address,
            status: row.status,
            updatedAt: row.updatedAt,
          })
          .where(eq(schema.suppliers.id, row.id))
      },
      /** Erasure destroys the copy rather than blanking it (ADR 0026). */
      erase: async (supplier) => {
        const row = supplier.toSnapshot()
        assertTenant(row.tenantId)
        await tx
          .update(schema.suppliers)
          .set({
            name: 'erased party',
            email: '',
            phone: '',
            address: '',
            status: 'erased',
            updatedAt: row.updatedAt,
          })
          .where(eq(schema.suppliers.id, row.id))
      },
    },
    catalogItems: {
      findById: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.catalogItems)
          .where(eq(schema.catalogItems.itemId, id))
          .limit(1)
        return row
          ? {
              tenantId: row.tenantId,
              itemId: row.itemId,
              description: restored(LineDescription.create(row.description)),
              active: row.active,
            }
          : null
      },
      recordItem: async (item) => {
        assertTenant(item.tenantId)
        await tx
          .insert(schema.catalogItems)
          .values({
            tenantId: item.tenantId,
            itemId: item.itemId,
            description: item.description.value,
            active: true,
          })
          .onConflictDoUpdate({
            target: [schema.catalogItems.tenantId, schema.catalogItems.itemId],
            set: { description: item.description.value, updatedAt: new Date() },
          })
      },
      deactivate: async (itemId) => {
        await tx
          .update(schema.catalogItems)
          .set({ active: false, updatedAt: new Date() })
          .where(eq(schema.catalogItems.itemId, itemId))
      },
    },
    requisitions: {
      findById: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.requisitions)
          .where(eq(schema.requisitions.id, id))
          .limit(1)
        return row ? loadRequisition(tx, row) : null
      },
      findForUpdate: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.requisitions)
          .where(eq(schema.requisitions.id, id))
          .limit(1)
          .for('update')
        return row ? loadRequisition(tx, row) : null
      },
      create: async (requisition) => {
        const row = requisition.toSnapshot()
        assertTenant(row.tenantId)
        await tx.insert(schema.requisitions).values(headOf(row))
        await writeRequisitionLines(tx, row)
        await publishAll(tx, tenantId, requisition)
      },
      save: async (requisition) => {
        const row = requisition.toSnapshot()
        assertTenant(row.tenantId)
        await tx
          .update(schema.requisitions)
          .set({
            neededBy: row.neededBy,
            justification: row.justification,
            status: row.status,
            submittedBy: row.submittedBy,
            submittedAt: row.submittedAt,
            decidedBy: row.decidedBy,
            decidedAt: row.decidedAt,
            decisionReason: row.decisionReason,
            orderId: row.orderId,
            closureReason: row.closureReason,
            version: row.version,
            updatedAt: row.updatedAt,
          })
          .where(eq(schema.requisitions.id, row.id))
        if (row.status === 'draft') {
          await tx
            .delete(schema.requisitionLines)
            .where(eq(schema.requisitionLines.requisitionId, row.id))
          await writeRequisitionLines(tx, row)
        }
        await publishAll(tx, tenantId, requisition)
      },
    },
    quotations: {
      findById: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.quotations)
          .where(eq(schema.quotations.id, id))
          .limit(1)
        return row ? loadQuotation(tx, row) : null
      },
      findForUpdate: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.quotations)
          .where(eq(schema.quotations.id, id))
          .limit(1)
          .for('update')
        return row ? loadQuotation(tx, row) : null
      },
      listForRequisition: async (requisitionId) => {
        const rows = await tx
          .select()
          .from(schema.quotations)
          .where(eq(schema.quotations.requisitionId, requisitionId))
          .orderBy(asc(schema.quotations.total), asc(schema.quotations.id))
          .for('update')
        const quotations: SupplierQuotation[] = []
        for (const row of rows) quotations.push(await loadQuotation(tx, row))
        return quotations
      },
      create: async (quotation) => {
        const row = quotation.toSnapshot()
        assertTenant(row.tenantId)
        await tx.insert(schema.quotations).values({
          id: row.id,
          tenantId: row.tenantId,
          requisitionId: row.requisitionId,
          supplierId: row.supplierId,
          reference: row.reference,
          quotedOn: row.quotedOn,
          validUntil: row.validUntil,
          currency: row.currency,
          tax: BigInt(row.tax),
          freight: BigInt(row.freight),
          otherCharges: BigInt(row.otherCharges),
          discount: BigInt(row.discount),
          total: BigInt(row.total),
          paymentTermDays: [...row.paymentTermDays],
          leadTimeDays: row.leadTimeDays,
          notes: row.notes,
          status: row.status,
          recordedBy: row.recordedBy,
          decidedAt: row.decidedAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })
        await tx.insert(schema.quotationLines).values(
          row.lines.map((line) => ({
            tenantId: row.tenantId,
            quotationId: row.id,
            lineId: line.lineId,
            itemId: line.itemId,
            description: line.description,
            quantity: microsOf(line.quantity),
            unitPrice: BigInt(line.unitPrice),
            lineTotal: BigInt(line.lineTotal),
          })),
        )
        await publishAll(tx, tenantId, quotation)
      },
      save: async (quotation) => {
        const row = quotation.toSnapshot()
        assertTenant(row.tenantId)
        await tx
          .update(schema.quotations)
          .set({ status: row.status, decidedAt: row.decidedAt, updatedAt: row.updatedAt })
          .where(eq(schema.quotations.id, row.id))
        await publishAll(tx, tenantId, quotation)
      },
    },
    orders: {
      findById: async (id) => {
        const [row] = await tx.select().from(schema.orders).where(eq(schema.orders.id, id)).limit(1)
        return row ? loadOrder(tx, row) : null
      },
      findForUpdate: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.orders)
          .where(eq(schema.orders.id, id))
          .limit(1)
          .for('update')
        return row ? loadOrder(tx, row) : null
      },
      create: async (order) => {
        const row = order.toSnapshot()
        assertTenant(row.tenantId)
        await tx.insert(schema.orders).values({
          id: row.id,
          tenantId: row.tenantId,
          supplierId: row.supplierId,
          supplierName: row.supplierName,
          requisitionId: row.requisitionId,
          quotationId: row.quotationId,
          warehouseId: row.warehouseId,
          currency: row.currency,
          tax: BigInt(row.tax),
          freight: BigInt(row.freight),
          otherCharges: BigInt(row.otherCharges),
          discount: BigInt(row.discount),
          total: BigInt(row.total),
          paymentTermDays: [...row.paymentTermDays],
          issuedOn: row.issuedOn,
          expectedOn: row.expectedOn,
          notes: row.notes,
          status: row.status,
          approvalState: row.approvalState,
          approvalRequestedBy: row.approvalRequestedBy,
          approvalRequestedAt: row.approvalRequestedAt,
          approvalDecidedBy: row.approvalDecidedBy,
          approvalDecidedAt: row.approvalDecidedAt,
          approvalReason: row.approvalReason,
          closureReason: row.closureReason,
          receipts: row.receipts,
          version: row.version,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })
        await writeOrderLines(tx, row)
        await publishAll(tx, tenantId, order)
      },
      save: async (order) => {
        const row = order.toSnapshot()
        assertTenant(row.tenantId)
        if (row.status === 'draft') {
          await tx.delete(schema.orderLines).where(eq(schema.orderLines.orderId, row.id))
          await writeOrderLines(tx, row)
        }
        await tx
          .update(schema.orders)
          .set({
            tax: BigInt(row.tax),
            freight: BigInt(row.freight),
            otherCharges: BigInt(row.otherCharges),
            discount: BigInt(row.discount),
            total: BigInt(row.total),
            paymentTermDays: [...row.paymentTermDays],
            expectedOn: row.expectedOn,
            notes: row.notes,
            status: row.status,
            approvalState: row.approvalState,
            approvalRequestedBy: row.approvalRequestedBy,
            approvalRequestedAt: row.approvalRequestedAt,
            approvalDecidedBy: row.approvalDecidedBy,
            approvalDecidedAt: row.approvalDecidedAt,
            approvalReason: row.approvalReason,
            closureReason: row.closureReason,
            receipts: row.receipts,
            version: row.version,
            updatedAt: row.updatedAt,
          })
          .where(eq(schema.orders.id, row.id))
        for (const line of row.lines)
          await tx
            .update(schema.orderLines)
            .set({ received: microsOf(line.received) })
            .where(
              and(eq(schema.orderLines.orderId, row.id), eq(schema.orderLines.lineId, line.lineId)),
            )
        await publishAll(tx, tenantId, order)
      },
    },
    receipts: {
      findById: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.receipts)
          .where(eq(schema.receipts.id, id))
          .limit(1)
        return row ? loadReceipt(tx, row) : null
      },
      findForUpdate: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.receipts)
          .where(eq(schema.receipts.id, id))
          .limit(1)
          .for('update')
        return row ? loadReceipt(tx, row) : null
      },
      listForOrder: async (orderId) => {
        const rows = await tx
          .select()
          .from(schema.receipts)
          .where(eq(schema.receipts.orderId, orderId))
          .orderBy(asc(schema.receipts.receivedOn), asc(schema.receipts.id))
        const found: GoodsReceipt[] = []
        for (const row of rows) found.push(await loadReceipt(tx, row))
        return found
      },
      create: async (receipt) => {
        const row = receipt.toSnapshot()
        assertTenant(row.tenantId)
        await tx.insert(schema.receipts).values({
          id: row.id,
          tenantId: row.tenantId,
          orderId: row.orderId,
          warehouseId: row.warehouseId,
          receivedOn: row.receivedOn,
          receivedBy: row.receivedBy,
          currency: row.currency,
          value: BigInt(row.value),
          notes: row.notes,
          overrideReason: row.overrideReason,
          status: row.status,
          returnedBy: row.returnedBy,
          returnedAt: row.returnedAt,
          returnReason: row.returnReason,
          createdAt: row.createdAt,
        })
        await tx.insert(schema.receiptLines).values(
          row.lines.map((line) => ({
            tenantId: row.tenantId,
            receiptId: row.id,
            lineId: line.lineId,
            itemId: line.itemId,
            description: line.description,
            quantity: microsOf(line.quantity),
            unitPrice: BigInt(line.unitPrice),
            lineTotal: BigInt(line.lineTotal),
          })),
        )
        await publishAll(tx, tenantId, receipt)
      },
      save: async (receipt) => {
        const row = receipt.toSnapshot()
        assertTenant(row.tenantId)
        await tx
          .update(schema.receipts)
          .set({
            status: row.status,
            returnedBy: row.returnedBy,
            returnedAt: row.returnedAt,
            returnReason: row.returnReason,
          })
          .where(eq(schema.receipts.id, row.id))
        await publishAll(tx, tenantId, receipt)
      },
    },
    policies: {
      find: async (currency) => {
        const [row] = await tx
          .select()
          .from(schema.approvalPolicies)
          .where(eq(schema.approvalPolicies.currency, currency))
          .limit(1)
        return row ?? null
      },
      list: async () =>
        await tx
          .select()
          .from(schema.approvalPolicies)
          .orderBy(asc(schema.approvalPolicies.currency)),
      save: async (policy) => {
        if (policy.tenantId !== tenantId)
          throw new Error('Aggregate tenant does not match transaction')
        await tx
          .insert(schema.approvalPolicies)
          .values(policy)
          .onConflictDoUpdate({
            target: [schema.approvalPolicies.tenantId, schema.approvalPolicies.currency],
            set: {
              threshold: policy.threshold,
              updatedBy: policy.updatedBy,
              updatedAt: policy.updatedAt,
            },
          })
      },
    },
    audit: auditTrail(tx, tenantId),
  }
}

type RequisitionRow = ReturnType<PurchaseRequisition['toSnapshot']>
type OrderRow = ReturnType<PurchaseOrder['toSnapshot']>

function headOf(row: RequisitionRow) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    requestedBy: row.requestedBy,
    warehouseId: row.warehouseId,
    neededBy: row.neededBy,
    justification: row.justification,
    status: row.status,
    submittedBy: row.submittedBy,
    submittedAt: row.submittedAt,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
    decisionReason: row.decisionReason,
    orderId: row.orderId,
    closureReason: row.closureReason,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function writeRequisitionLines(tx: Transaction, row: RequisitionRow) {
  return tx.insert(schema.requisitionLines).values(
    row.lines.map((line) => ({
      tenantId: row.tenantId,
      requisitionId: row.id,
      lineId: line.lineId,
      itemId: line.itemId,
      description: line.description,
      quantity: microsOf(line.quantity),
    })),
  )
}

function writeOrderLines(tx: Transaction, row: OrderRow) {
  return tx.insert(schema.orderLines).values(
    row.lines.map((line) => ({
      tenantId: row.tenantId,
      orderId: row.id,
      lineId: line.lineId,
      itemId: line.itemId,
      description: line.description,
      quantity: microsOf(line.quantity),
      unitPrice: BigInt(line.unitPrice),
      lineTotal: BigInt(line.lineTotal),
    })),
  )
}

/** A snapshot renders a quantity as a decimal string; storage keeps the integer micros. */
export function microsOf(quantity: string): bigint {
  return restored(Quantity.create(quantity)).micros
}
