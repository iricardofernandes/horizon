import type { ConfirmedOrderLine } from '../events/sales-events'
import { Money } from '../value-objects/sales-values'
import { priceShipment, type ShippedLine } from './fulfilment'

/** One line of one delivery: the unit an NFS-e is issued for (ADR 0056). */
export interface DeliveredEntry extends ConfirmedOrderLine {
  readonly entryId: string
  /** What the line bills, after its share of the order discount. */
  readonly amount: Money
}

/**
 * What one delivery of a service order bills.
 *
 * The discount was agreed for the order as a whole, so a partial delivery carries it in
 * proportion to the work in it, rounded down. The delivery that completes the order bills
 * whatever the active deliveries have not, so the deliveries of a completed order always
 * add up to its total — even after one of them was cancelled and the work delivered again.
 */
export function billDelivery(input: {
  readonly lines: readonly ConfirmedOrderLine[]
  readonly total: Money
  readonly net: Money
  readonly billed: Money
  readonly delivery: readonly ShippedLine[]
  readonly completes: boolean
  readonly entryId: () => string
}): { readonly entries: readonly DeliveredEntry[]; readonly value: Money } {
  const priced = priceShipment(input.lines, input.delivery)
  const gross = priced.reduce((sum, line) => sum + line.lineTotal.amount, 0n)
  const currency = input.total.currency
  const value = input.completes
    ? input.total.minus(input.billed)
    : Money.fromAmount(
        input.net.isZero() ? 0n : (input.total.amount * gross) / input.net.amount,
        currency,
      )
  return { entries: spread(priced, value, gross, input.entryId), value }
}

/** The delivery's value across its lines, by gross value; the last line takes the rest. */
function spread(
  priced: readonly ConfirmedOrderLine[],
  value: Money,
  gross: bigint,
  entryId: () => string,
): readonly DeliveredEntry[] {
  let assigned = 0n
  return priced.map((line, index) => {
    const last = index === priced.length - 1
    const amount = last
      ? value.amount - assigned
      : gross === 0n
        ? 0n
        : (value.amount * line.lineTotal.amount) / gross
    assigned += amount
    return { ...line, entryId: entryId(), amount: Money.fromAmount(amount, value.currency) }
  })
}

/**
 * How a proposal's discount divides between its goods and its services: in proportion to
 * each side's net, rounded down for the services, so the goods take the remainder.
 */
export function discountShare(discount: Money, net: Money, servicesNet: Money): Money {
  if (net.isZero()) return Money.fromAmount(0n, discount.currency)
  return Money.fromAmount((discount.amount * servicesNet.amount) / net.amount, discount.currency)
}
