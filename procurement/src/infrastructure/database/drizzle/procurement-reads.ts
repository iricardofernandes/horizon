import { sql } from 'drizzle-orm'
import type { Transaction } from './procurement-store'

const MICROS = 1_000_000

/** Integer micros back to the decimal string the wire uses. */
const quantity = (column: string) =>
  sql.raw(`trim(trailing '.' from trim(trailing '0' from (${column}::numeric / ${MICROS})::text))`)

export type Page<T> = {
  readonly data: readonly T[]
  readonly total: number
}

export type RequisitionRow = {
  readonly id: string
  readonly requestedBy: string
  readonly warehouseId: string
  readonly neededBy: string
  readonly status: string
  readonly submittedBy: string | null
  readonly decidedBy: string | null
  readonly orderId: string | null
  readonly lines: number
  readonly quotations: number
  readonly createdAt: string
  readonly updatedAt: string
}

/**
 * The requisition list, newest first, with the two counts a reader decides from: how much
 * was asked for, and how many suppliers have answered.
 */
export async function listRequisitions(
  tx: Transaction,
  filter: { status: string | null; limit: number; offset: number },
): Promise<Page<RequisitionRow>> {
  const status = filter.status
  const where = status ? sql`where r.status = ${status}` : sql``
  const rows = await tx.execute<RequisitionRow & { total: number }>(sql`
    select r.id, r.requested_by as "requestedBy", r.warehouse_id as "warehouseId",
      r.needed_by as "neededBy", r.status, r.submitted_by as "submittedBy",
      r.decided_by as "decidedBy", r.order_id as "orderId",
      (select count(*)::int from requisition_lines l where l.requisition_id = r.id) as lines,
      (select count(*)::int from quotations q where q.requisition_id = r.id) as quotations,
      r.created_at as "createdAt", r.updated_at as "updatedAt",
      count(*) over ()::int as total
    from requisitions r
    ${where}
    order by r.created_at desc, r.id
    limit ${filter.limit} offset ${filter.offset}
  `)
  return { data: rows.map(({ total: _total, ...row }) => row), total: rows[0]?.total ?? 0 }
}

export type RequisitionDetail = RequisitionRow & {
  readonly justification: string | null
  readonly decisionReason: string | null
  readonly closureReason: string | null
  readonly version: number
  readonly data: readonly {
    readonly lineId: string
    readonly itemId: string
    readonly description: string
    readonly quantity: string
  }[]
}

export async function requisitionDetail(
  tx: Transaction,
  id: string,
): Promise<RequisitionDetail | null> {
  const [head] = await tx.execute<Omit<RequisitionDetail, 'data'>>(sql`
    select r.id, r.requested_by as "requestedBy", r.warehouse_id as "warehouseId",
      r.needed_by as "neededBy", r.status, r.submitted_by as "submittedBy",
      r.decided_by as "decidedBy", r.decision_reason as "decisionReason",
      r.closure_reason as "closureReason", r.order_id as "orderId", r.justification, r.version,
      (select count(*)::int from requisition_lines l where l.requisition_id = r.id) as lines,
      (select count(*)::int from quotations q where q.requisition_id = r.id) as quotations,
      r.created_at as "createdAt", r.updated_at as "updatedAt"
    from requisitions r where r.id = ${id}::uuid
  `)
  if (!head) return null
  const data = await tx.execute<RequisitionDetail['data'][number]>(sql`
    select l.line_id as "lineId", l.item_id as "itemId", l.description,
      ${quantity('l.quantity')} as quantity
    from requisition_lines l where l.requisition_id = ${id}::uuid order by l.line_id
  `)
  return { ...head, data }
}

export type QuotationRow = {
  readonly id: string
  readonly requisitionId: string
  readonly supplierId: string
  readonly supplierName: string
  readonly reference: string
  readonly quotedOn: string
  readonly validUntil: string | null
  readonly currency: string
  readonly tax: string
  readonly freight: string
  readonly otherCharges: string
  readonly discount: string
  readonly total: string
  readonly paymentTermDays: readonly number[]
  readonly leadTimeDays: number
  readonly status: string
  readonly notes: string | null
}

export async function listQuotations(
  tx: Transaction,
  requisitionId: string,
): Promise<readonly QuotationRow[]> {
  return tx.execute<QuotationRow>(sql`
    select q.id, q.requisition_id as "requisitionId", q.supplier_id as "supplierId",
      s.name as "supplierName", q.reference, q.quoted_on as "quotedOn",
      q.valid_until as "validUntil", q.currency, q.tax::text, q.freight::text,
      q.other_charges::text as "otherCharges", q.discount::text, q.total::text,
      q.payment_term_days as "paymentTermDays", q.lead_time_days as "leadTimeDays",
      q.status, q.notes
    from quotations q
    join suppliers s on s.id = q.supplier_id
    where q.requisition_id = ${requisitionId}::uuid
    order by q.total, q.id
  `)
}

export type ComparisonLine = {
  readonly lineId: string
  readonly itemId: string
  readonly description: string
  readonly quantity: string
  readonly offers: readonly {
    readonly quotationId: string
    readonly supplierId: string
    readonly supplierName: string
    readonly unitPrice: string
    readonly lineTotal: string
    /** Is this the cheapest offer for the line? Ties are all marked best. */
    readonly best: boolean
  }[]
}

export type Comparison = {
  readonly requisitionId: string
  readonly currency: string | null
  readonly quotations: readonly QuotationRow[]
  readonly lines: readonly ComparisonLine[]
}

/**
 * Every offer against every line of the requisition, side by side.
 *
 * The cheapest unit price per line is marked here rather than in the screen, because
 * "best" is a comparison of integers and doing it once means the table and whoever reads
 * the API agree about it. It is per line and deliberately not a verdict on the quotation
 * as a whole: freight, lead time and terms are part of the decision and a person weighs
 * them.
 */
export async function quotationComparison(
  tx: Transaction,
  requisitionId: string,
): Promise<Comparison> {
  const quotations = await listQuotations(tx, requisitionId)
  const rows = await tx.execute<{
    lineId: string
    itemId: string
    description: string
    quantity: string
    quotationId: string | null
    supplierId: string | null
    supplierName: string | null
    unitPrice: string | null
    lineTotal: string | null
    best: boolean
  }>(sql`
    select r.line_id as "lineId", r.item_id as "itemId", r.description,
      ${quantity('r.quantity')} as quantity,
      q.id as "quotationId", q.supplier_id as "supplierId", s.name as "supplierName",
      l.unit_price::text as "unitPrice", l.line_total::text as "lineTotal",
      coalesce(l.unit_price = min(l.unit_price) over (partition by r.line_id), false) as best
    from requisition_lines r
    left join quotation_lines l on l.line_id = r.line_id
    left join quotations q on q.id = l.quotation_id and q.requisition_id = r.requisition_id
    left join suppliers s on s.id = q.supplier_id
    where r.requisition_id = ${requisitionId}::uuid
    order by r.line_id, l.unit_price
  `)
  const lines = new Map<string, ComparisonLine & { offers: ComparisonLine['offers'][number][] }>()
  for (const row of rows) {
    const line = lines.get(row.lineId) ?? {
      lineId: row.lineId,
      itemId: row.itemId,
      description: row.description,
      quantity: row.quantity,
      offers: [],
    }
    if (row.quotationId && row.supplierId && row.unitPrice && row.lineTotal)
      line.offers.push({
        quotationId: row.quotationId,
        supplierId: row.supplierId,
        supplierName: row.supplierName ?? '',
        unitPrice: row.unitPrice,
        lineTotal: row.lineTotal,
        best: row.best,
      })
    lines.set(row.lineId, line)
  }
  return {
    requisitionId,
    currency: quotations[0]?.currency ?? null,
    quotations,
    lines: [...lines.values()],
  }
}

export type OrderRow = {
  readonly id: string
  readonly supplierId: string
  readonly supplierName: string
  readonly requisitionId: string | null
  readonly warehouseId: string
  readonly currency: string
  readonly total: string
  readonly issuedOn: string
  readonly expectedOn: string
  readonly status: string
  readonly approvalState: string
  readonly receipts: number
  readonly lines: number
  readonly updatedAt: string
}

export async function listOrders(
  tx: Transaction,
  filter: { status: string | null; supplierId: string | null; limit: number; offset: number },
): Promise<Page<OrderRow>> {
  const conditions = [
    filter.status ? sql`o.status = ${filter.status}` : null,
    filter.supplierId ? sql`o.supplier_id = ${filter.supplierId}::uuid` : null,
  ].filter((condition) => condition !== null)
  const where = conditions.length ? sql`where ${sql.join(conditions, sql` and `)}` : sql``
  const rows = await tx.execute<OrderRow & { total_rows: number }>(sql`
    select o.id, o.supplier_id as "supplierId", o.supplier_name as "supplierName",
      o.requisition_id as "requisitionId", o.warehouse_id as "warehouseId", o.currency,
      o.total::text, o.issued_on as "issuedOn", o.expected_on as "expectedOn",
      o.status, o.approval_state as "approvalState", o.receipts,
      (select count(*)::int from order_lines l where l.order_id = o.id) as lines,
      o.updated_at as "updatedAt",
      count(*) over ()::int as total_rows
    from orders o
    ${where}
    order by o.issued_on desc, o.id
    limit ${filter.limit} offset ${filter.offset}
  `)
  return {
    data: rows.map(({ total_rows: _rows, ...row }) => row),
    total: rows[0]?.total_rows ?? 0,
  }
}

export type OrderDetail = OrderRow & {
  readonly quotationId: string | null
  readonly tax: string
  readonly freight: string
  readonly otherCharges: string
  readonly discount: string
  readonly paymentTermDays: readonly number[]
  readonly notes: string | null
  readonly approvalRequestedBy: string | null
  readonly approvalDecidedBy: string | null
  readonly approvalReason: string | null
  readonly closureReason: string | null
  readonly version: number
  readonly data: readonly {
    readonly lineId: string
    readonly itemId: string
    readonly description: string
    readonly quantity: string
    readonly unitPrice: string
    readonly lineTotal: string
    readonly received: string
    readonly outstanding: string
  }[]
}

export async function orderDetail(tx: Transaction, id: string): Promise<OrderDetail | null> {
  const [head] = await tx.execute<Omit<OrderDetail, 'data'>>(sql`
    select o.id, o.supplier_id as "supplierId", o.supplier_name as "supplierName",
      o.requisition_id as "requisitionId", o.quotation_id as "quotationId",
      o.warehouse_id as "warehouseId", o.currency, o.tax::text, o.freight::text,
      o.other_charges::text as "otherCharges", o.discount::text, o.total::text,
      o.payment_term_days as "paymentTermDays", o.issued_on as "issuedOn",
      o.expected_on as "expectedOn", o.notes, o.status, o.approval_state as "approvalState",
      o.approval_requested_by as "approvalRequestedBy",
      o.approval_decided_by as "approvalDecidedBy", o.approval_reason as "approvalReason",
      o.closure_reason as "closureReason", o.version, o.receipts,
      (select count(*)::int from order_lines l where l.order_id = o.id) as lines,
      o.updated_at as "updatedAt"
    from orders o where o.id = ${id}::uuid
  `)
  if (!head) return null
  const data = await tx.execute<OrderDetail['data'][number]>(sql`
    select l.line_id as "lineId", l.item_id as "itemId", l.description,
      ${quantity('l.quantity')} as quantity,
      l.unit_price::text as "unitPrice", l.line_total::text as "lineTotal",
      ${quantity('l.received')} as received,
      ${quantity('greatest(l.quantity - l.received, 0)')} as outstanding
    from order_lines l where l.order_id = ${id}::uuid order by l.line_id
  `)
  return { ...head, data }
}

export type ReceiptRow = {
  readonly id: string
  readonly orderId: string
  readonly receivedOn: string
  readonly receivedBy: string
  readonly currency: string
  readonly value: string
  readonly status: string
  readonly notes: string | null
  readonly overrideReason: string | null
  readonly returnReason: string | null
  readonly lines: readonly {
    readonly lineId: string
    readonly itemId: string
    readonly description: string
    readonly quantity: string
  }[]
}

/** Every delivery against one order, oldest first: the conference a buyer reads. */
export async function listReceipts(
  tx: Transaction,
  orderId: string,
): Promise<readonly ReceiptRow[]> {
  const heads = await tx.execute<Omit<ReceiptRow, 'lines'>>(sql`
    select r.id, r.order_id as "orderId", r.received_on as "receivedOn",
      r.received_by as "receivedBy", r.currency, r.value::text, r.status, r.notes,
      r.override_reason as "overrideReason", r.return_reason as "returnReason"
    from receipts r where r.order_id = ${orderId}::uuid
    order by r.received_on, r.id
  `)
  if (heads.length === 0) return []
  const lines = await tx.execute<{
    receiptId: string
    lineId: string
    itemId: string
    description: string
    quantity: string
  }>(sql`
    select l.receipt_id as "receiptId", l.line_id as "lineId", l.item_id as "itemId",
      l.description, ${quantity('l.quantity')} as quantity
    from receipt_lines l
    join receipts r on r.id = l.receipt_id
    where r.order_id = ${orderId}::uuid
    order by l.receipt_id, l.line_id
  `)
  return heads.map((head) => ({
    ...head,
    lines: lines.filter((line) => line.receiptId === head.id),
  }))
}

export type SupplierRow = {
  readonly id: string
  readonly name: string
  readonly email: string
  readonly phone: string
  readonly status: string
  readonly orders: number
}

export async function listSuppliers(
  tx: Transaction,
  limit: number,
): Promise<readonly SupplierRow[]> {
  return tx.execute<SupplierRow>(sql`
    select s.id, s.name, s.email, s.phone, s.status,
      (select count(*)::int from orders o where o.supplier_id = s.id) as orders
    from suppliers s
    where s.status <> 'erased'
    order by s.name
    limit ${limit}
  `)
}

export type PolicyRow = {
  readonly currency: string
  readonly threshold: string
  readonly updatedBy: string
  readonly updatedAt: string
}

export async function listPolicies(tx: Transaction): Promise<readonly PolicyRow[]> {
  return tx.execute<PolicyRow>(sql`
    select p.currency, p.threshold::text, p.updated_by as "updatedBy", p.updated_at as "updatedAt"
    from approval_policies p order by p.currency
  `)
}
