import {
  financialPayablePosted,
  financialPayableReversed,
  procurementOrderApproved,
  procurementReceiptRecorded,
  procurementReceiptReturned,
} from '@horizon/contracts'
import type postgres from 'postgres'

type Transaction = postgres.TransactionSql

export const PURCHASE_EVENT_TYPES = [
  'procurement.order.approved',
  'procurement.receipt.recorded',
  'procurement.receipt.returned',
  'financial.payable.posted',
  'financial.payable.reversed',
] as const

/**
 * Read-only copies of what Procurement received and Financial owes, used only to compare
 * supplier invoices. The inbox has already claimed the event, so each fact applies once;
 * Fiscal never writes back to either owner.
 */
export async function projectPurchaseEvent(
  tx: Transaction,
  tenantId: string,
  eventType: (typeof PURCHASE_EVENT_TYPES)[number],
  raw: unknown,
): Promise<void> {
  switch (eventType) {
    case 'procurement.order.approved': {
      const order = procurementOrderApproved.payload.parse(raw)
      for (const line of order.lines)
        await tx`insert into fiscal_purchase_order_lines
          (tenant_id, order_id, line_id, supplier_id, item_id, quantity, unit_price_minor, currency)
          values (${tenantId}, ${order.orderId}, ${line.lineId}, ${order.supplierId},
            ${line.itemId}, ${line.quantity}, ${line.unitPrice.amount}, ${line.unitPrice.currency})
          on conflict do nothing`
      return
    }
    case 'procurement.receipt.recorded': {
      const receipt = procurementReceiptRecorded.payload.parse(raw)
      const inserted = await tx`insert into fiscal_purchase_receipts
        (tenant_id, receipt_id, order_id, supplier_id, warehouse_id, received_on, value_minor, currency)
        values (${tenantId}, ${receipt.receiptId}, ${receipt.orderId}, ${receipt.supplierId},
          ${receipt.warehouseId}, ${receipt.receivedOn}, ${receipt.value.amount}, ${receipt.value.currency})
        on conflict do nothing returning receipt_id`
      if (inserted.length === 0)
        throw new Error('Conflicting Procurement receipt for an already projected receipt')
      for (const line of receipt.lines)
        await tx`insert into fiscal_purchase_receipt_lines
          (tenant_id, receipt_id, line_id, item_id, quantity, unit_price_minor, line_total_minor, currency)
          values (${tenantId}, ${receipt.receiptId}, ${line.lineId}, ${line.itemId}, ${line.quantity},
            ${line.unitPrice.amount}, ${line.lineTotal.amount}, ${line.unitPrice.currency})`
      return
    }
    case 'procurement.receipt.returned': {
      const returned = procurementReceiptReturned.payload.parse(raw)
      const [known] = await tx`select returned_at from fiscal_purchase_receipts
        where tenant_id = ${tenantId} and receipt_id = ${returned.receiptId} for update`
      // A receipt recorded before Fiscal followed Procurement was never projected.
      if (!known) return
      if (known.returned_at !== null) throw new Error('Projected receipt was already returned')
      await tx`update fiscal_purchase_receipts set returned_at = now()
        where tenant_id = ${tenantId} and receipt_id = ${returned.receiptId}`
      for (const line of returned.lines) {
        const changed = await tx`update fiscal_purchase_receipt_lines
          set returned_quantity = returned_quantity + ${line.quantity}::numeric
          where tenant_id = ${tenantId} and receipt_id = ${returned.receiptId}
            and line_id = ${line.lineId} and item_id = ${line.itemId} returning line_id`
        if (changed.length === 0) throw new Error('Returned line is not part of the receipt')
      }
      return
    }
    case 'financial.payable.posted': {
      const payable = financialPayablePosted.payload.parse(raw)
      if (payable.origin.type !== 'purchase-receipt') return
      await tx`insert into fiscal_purchase_payables
        (tenant_id, title_id, receipt_id, party_id, total_minor, currency, posted_at)
        values (${tenantId}, ${payable.titleId}, ${payable.origin.documentId}, ${payable.partyId},
          ${payable.total.amount}, ${payable.total.currency}, ${payable.postedAt})
        on conflict do nothing`
      return
    }
    case 'financial.payable.reversed': {
      const reversed = financialPayableReversed.payload.parse(raw)
      await tx`update fiscal_purchase_payables set reversed_at = ${reversed.reversedAt}
        where tenant_id = ${tenantId} and title_id = ${reversed.titleId} and reversed_at is null`
      return
    }
  }
}
