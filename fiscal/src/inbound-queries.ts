import type postgres from 'postgres'
import type { ItemMapping, OpenReceiptLine } from './inbound-matching'

type Transaction = postgres.TransactionSql

/**
 * Received lines of these suppliers with quantity still open: what arrived, less what went
 * back, less what committed reconciliations already allocated. `lock` holds the rows until
 * the caller's transaction ends, so two reviewers cannot allocate the same quantity.
 */
export async function loadOpenReceiptLines(
  tx: Transaction,
  tenantId: string,
  supplierIds: readonly string[],
  lock = false,
): Promise<OpenReceiptLine[]> {
  if (supplierIds.length === 0) return []
  if (lock)
    await tx`select l.line_id from fiscal_purchase_receipt_lines l
      join fiscal_purchase_receipts r on r.tenant_id = l.tenant_id and r.receipt_id = l.receipt_id
      where l.tenant_id = ${tenantId} and r.supplier_id in ${tx(supplierIds)}
      order by l.receipt_id, l.line_id for update of l`
  const rows = await tx`
    select l.receipt_id, r.order_id, l.line_id, l.item_id, r.received_on::text as received_on,
      trim_scale(l.quantity - l.returned_quantity - coalesce(a.allocated, 0))::text as open_quantity,
      l.unit_price_minor::text as unit_price_minor, l.currency
    from fiscal_purchase_receipt_lines l
    join fiscal_purchase_receipts r on r.tenant_id = l.tenant_id and r.receipt_id = l.receipt_id
    left join (
      select tenant_id, receipt_id, receipt_line_id, sum(quantity) as allocated
      from fiscal_inbound_reconciliation_lines where tenant_id = ${tenantId}
      group by tenant_id, receipt_id, receipt_line_id
    ) a on a.tenant_id = l.tenant_id and a.receipt_id = l.receipt_id and a.receipt_line_id = l.line_id
    where l.tenant_id = ${tenantId} and r.supplier_id in ${tx(supplierIds)}
      and l.quantity - l.returned_quantity - coalesce(a.allocated, 0) > 0
    order by r.received_on, r.recorded_at, l.receipt_id, l.line_id`
  return rows.map((row) => ({
    receiptId: String(row.receipt_id),
    orderId: String(row.order_id),
    lineId: String(row.line_id),
    itemId: String(row.item_id),
    receivedOn: String(row.received_on),
    openQuantity: String(row.open_quantity),
    unitPriceMinor: String(row.unit_price_minor),
    currency: String(row.currency),
  }))
}

/** The latest remembered mapping of each supplier product code. */
export async function loadItemMappings(
  tx: Transaction,
  tenantId: string,
  supplierId: string,
): Promise<ItemMapping[]> {
  const rows = await tx`
    select distinct on (product_code) product_code, item_id, trim_scale(factor)::text as factor
    from fiscal_supplier_item_mappings
    where tenant_id = ${tenantId} and supplier_party_id = ${supplierId}
    order by product_code, version desc`
  return rows.map((row) => ({
    productCode: String(row.product_code),
    itemId: String(row.item_id),
    factor: String(row.factor),
  }))
}

/** The latest known NCM of each item; an item never classified maps to null. */
export async function loadNcmByItem(
  tx: Transaction,
  tenantId: string,
  itemIds: readonly string[],
): Promise<Map<string, string | null>> {
  if (itemIds.length === 0) return new Map()
  const rows = await tx`
    select distinct on (item_id) item_id, ncm from catalog_classifications
    where tenant_id = ${tenantId} and item_id in ${tx([...new Set(itemIds)])}
    order by item_id, effective_from desc, revision desc`
  return new Map(
    rows.map((row) => [String(row.item_id), row.ncm === null ? null : String(row.ncm)]),
  )
}
