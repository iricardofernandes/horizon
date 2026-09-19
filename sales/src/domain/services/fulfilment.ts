import type { ConfirmedOrderLine } from '../events/sales-events'
import type { BusinessDate, PaymentTerms, Quantity } from '../value-objects/sales-values'
import { Money } from '../value-objects/sales-values'

/** What left the warehouse, against one line of the order. */
export interface ShippedLine {
  readonly lineId: string
  readonly quantity: Quantity
}

export interface Installment {
  readonly number: number
  readonly dueOn: BusinessDate
  readonly amount: Money
}

/**
 * What one delivery makes owed, and what the order is still only expected to deliver.
 *
 * The order is the only thing that knows its own terms, so it works both schedules out
 * here and publishes them already dated. Nothing downstream has to know that payment terms
 * were agreed as day offsets, or how a total divides.
 */
export interface ShipmentPlan {
  readonly lines: readonly ConfirmedOrderLine[]
  readonly value: Money
  readonly installments: readonly Installment[]
  readonly remaining: Money
  readonly remainingInstallments: readonly Installment[]
  readonly complete: boolean
}

export function quantityShipped(
  shipped: readonly ShippedLine[],
  lineId: string,
): Quantity | undefined {
  return shipped.find((line) => line.lineId === lineId)?.quantity
}

/**
 * The share of the order's total that a given amount of goods carries.
 *
 * Freight and the discount were agreed for the order as a whole, so a partial delivery
 * carries them in proportion to the goods in it. Taking the *cumulative* share and
 * subtracting what earlier deliveries already carried is what makes the parts add back up
 * to the whole exactly: the rounding never accumulates, and the delivery that completes an
 * order leaves nothing behind.
 */
export function shareOf(orderTotal: Money, orderNet: Money, shippedNet: Money): Money {
  if (shippedNet.isZero()) return Money.fromAmount(0n, orderTotal.currency)
  if (orderNet.isZero()) return orderTotal
  return Money.fromAmount(
    (orderTotal.amount * shippedNet.amount) / orderNet.amount,
    orderTotal.currency,
  )
}

/** The goods of a delivery, priced from the order's own confirmed lines. */
export function priceShipment(
  confirmed: readonly ConfirmedOrderLine[],
  shipped: readonly ShippedLine[],
): readonly ConfirmedOrderLine[] {
  const byId = new Map(confirmed.map((line) => [line.lineId, line]))
  const lines: ConfirmedOrderLine[] = []
  for (const line of shipped) {
    const source = byId.get(line.lineId)
    if (!source) continue
    lines.push({
      lineId: line.lineId,
      itemId: source.itemId,
      quantity: line.quantity,
      description: source.description,
      unitPrice: source.unitPrice,
      lineTotal: source.unitPrice.multiply(line.quantity),
    })
  }
  return lines
}

/** Add up what has left so far, at the order's own prices. */
export function netOfShipped(
  confirmed: readonly ConfirmedOrderLine[],
  shipped: readonly ShippedLine[],
  currency: Money['currency'],
): Money {
  return priceShipment(confirmed, shipped).reduce(
    (sum, line) => sum.plus(line.lineTotal),
    Money.fromAmount(0n, currency),
  )
}

export function scheduleFrom(
  terms: PaymentTerms,
  total: Money,
  from: BusinessDate,
): readonly Installment[] {
  if (total.isZero()) return []
  return terms.scheduleOf(total, from)
}

/** What a delivery adds to, or takes away from, everything shipped so far. */
export function merge(
  shipped: readonly ShippedLine[],
  delivery: readonly ShippedLine[],
): readonly ShippedLine[] {
  const merged = new Map(shipped.map((line) => [line.lineId, line]))
  for (const line of delivery) {
    const existing = merged.get(line.lineId)
    merged.set(line.lineId, {
      lineId: line.lineId,
      quantity: existing ? existing.quantity.plus(line.quantity) : line.quantity,
    })
  }
  return [...merged.values()]
}

export function subtract(
  shipped: readonly ShippedLine[],
  returned: readonly ShippedLine[],
): readonly ShippedLine[] | null {
  const remaining = new Map(shipped.map((line) => [line.lineId, line]))
  for (const line of returned) {
    const existing = remaining.get(line.lineId)
    if (!existing || existing.quantity.isLessThan(line.quantity)) return null
    const left = existing.quantity.minus(line.quantity)
    if (left.isZero()) remaining.delete(line.lineId)
    else remaining.set(line.lineId, { lineId: line.lineId, quantity: left })
  }
  return [...remaining.values()]
}
