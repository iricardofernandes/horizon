import type {
  BusinessDate,
  Currency,
  PaymentTerms,
  Quantity,
} from '../value-objects/procurement-values'
import { Money } from '../value-objects/procurement-values'
import type { PricedLine } from './pricing'

/** What arrived, against one line of the order. */
export interface ReceivedLine {
  readonly lineId: string
  readonly quantity: Quantity
}

export interface ReceiptLine extends ReceivedLine {
  readonly itemId: string
  readonly description: string
  readonly unitPrice: Money
  readonly lineTotal: Money
}

export interface Installment {
  readonly number: number
  readonly dueOn: BusinessDate
  readonly amount: Money
}

/**
 * What one receipt makes owed, and what is left committed after it.
 *
 * The order is the only thing that knows its own terms, so it works both schedules out
 * here and publishes them already dated. Nothing downstream has to know that the terms
 * were agreed as day offsets, or how a total divides.
 */
export interface ReceiptPlan {
  readonly lines: readonly ReceiptLine[]
  readonly value: Money
  readonly installments: readonly Installment[]
  readonly remaining: Money
  readonly remainingInstallments: readonly Installment[]
  readonly complete: boolean
  readonly overReceipt: boolean
}

export function quantityReceived(
  received: readonly ReceivedLine[],
  lineId: string,
): Quantity | undefined {
  return received.find((line) => line.lineId === lineId)?.quantity
}

/**
 * The share of the order's total that a given amount of goods carries.
 *
 * Tax, freight and the discount are agreed for the order as a whole, so a partial delivery
 * carries them in proportion to the goods in it. Taking the *cumulative* share and
 * subtracting what earlier receipts already carried is what makes the parts add back up to
 * the whole exactly: the rounding never accumulates, and the last delivery of a complete
 * order leaves nothing behind.
 */
export function shareOf(orderTotal: Money, orderNet: Money, receivedNet: Money): Money {
  if (receivedNet.isZero()) return Money.zero(orderTotal.currency)
  if (orderNet.isZero()) return orderTotal
  return Money.of((orderTotal.amount * receivedNet.amount) / orderNet.amount, orderTotal.currency)
}

/** The goods of a receipt, priced from the order's own lines. */
export function priceReceipt(
  ordered: readonly PricedLine[],
  received: readonly ReceivedLine[],
): readonly ReceiptLine[] {
  const byId = new Map(ordered.map((line) => [line.lineId, line]))
  const lines: ReceiptLine[] = []
  for (const line of received) {
    const source = byId.get(line.lineId)
    if (!source) continue
    lines.push({
      lineId: line.lineId,
      itemId: source.itemId,
      description: source.description.value,
      quantity: line.quantity,
      unitPrice: source.unitPrice,
      lineTotal: source.unitPrice.multiply(line.quantity),
    })
  }
  return lines
}

export function scheduleFrom(
  terms: PaymentTerms,
  total: Money,
  from: BusinessDate,
): readonly Installment[] {
  if (total.isZero()) return []
  return terms
    .scheduleOf(total, from)
    .map((part, index) => ({ number: index + 1, dueOn: part.dueOn, amount: part.amount }))
}

/** Add up what has arrived so far, at the order's own prices. */
export function netOfReceived(
  ordered: readonly PricedLine[],
  received: readonly ReceivedLine[],
  currency: Currency,
): Money {
  return priceReceipt(ordered, received).reduce(
    (sum, line) => sum.plus(line.lineTotal),
    Money.zero(currency),
  )
}
