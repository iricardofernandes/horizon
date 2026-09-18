import { type Either, left, right } from '@/core/either'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import type { Currency, LineDescription, Quantity } from '../value-objects/procurement-values'
import { Money } from '../value-objects/procurement-values'

/** One priced line of a quotation or an order. The total is derived, never supplied. */
export interface PricedLine {
  readonly lineId: string
  readonly itemId: string
  readonly description: LineDescription
  readonly quantity: Quantity
  readonly unitPrice: Money
  readonly lineTotal: Money
}

export interface PricedLineInput {
  readonly lineId: string
  readonly itemId: string
  readonly description: LineDescription
  readonly quantity: Quantity
  readonly unitPrice: Money
}

/**
 * What a purchase costs beyond the goods themselves.
 *
 * They are held at the document's head rather than spread over the lines because that is
 * how a supplier quotes them — one freight charge for one delivery — and apportioning them
 * to lines is a costing decision that belongs to inventory valuation, not to the order.
 */
export interface Charges {
  readonly tax: Money
  readonly freight: Money
  readonly otherCharges: Money
  readonly discount: Money
}

export function noCharges(currency: Currency): Charges {
  return {
    tax: Money.zero(currency),
    freight: Money.zero(currency),
    otherCharges: Money.zero(currency),
    discount: Money.zero(currency),
  }
}

/** The goods alone, before tax and charges. */
export function netOf(lines: readonly PricedLine[], currency: Currency): Money {
  return lines.reduce((sum, line) => sum.plus(line.lineTotal), Money.zero(currency))
}

/** What will actually be owed: goods, plus tax and charges, less the discount. */
export function totalOf(lines: readonly PricedLine[], charges: Charges, currency: Currency): Money {
  return netOf(lines, currency)
    .plus(charges.tax)
    .plus(charges.freight)
    .plus(charges.otherCharges)
    .minus(charges.discount)
}

/**
 * Price the lines and refuse a document that cannot be owed.
 *
 * Everything is checked against one currency: a document that mixes currencies has no
 * total, and a total nobody can compute is a commitment nobody can approve.
 */
export function priceLines(
  inputs: readonly PricedLineInput[],
  charges: Charges,
  currency: Currency,
): Either<InvalidInputError, readonly PricedLine[]> {
  if (inputs.length === 0)
    return left(new InvalidInputError('/lines', 'a priced document requires at least one line'))
  if (new Set(inputs.map((line) => line.lineId)).size !== inputs.length)
    return left(new InvalidInputError('/lines', 'line identifiers must be unique'))
  if (new Set(inputs.map((line) => line.itemId)).size !== inputs.length)
    return left(new InvalidInputError('/lines', 'price each item once, in a single line'))
  if (inputs.some((line) => line.quantity.isZero()))
    return left(new InvalidInputError('/lines/quantity', 'quantities must be positive'))
  const mixed = [...inputs.map((line) => line.unitPrice), ...Object.values(charges)].some(
    (money) => !money.currency.equals(currency),
  )
  if (mixed)
    return left(new InvalidInputError('/currency', 'every amount must use the document currency'))
  const lines = inputs.map((line) => ({
    ...line,
    lineTotal: line.unitPrice.multiply(line.quantity),
  }))
  const beforeDiscount = netOf(lines, currency)
    .plus(charges.tax)
    .plus(charges.freight)
    .plus(charges.otherCharges)
  if (beforeDiscount.isLessThan(charges.discount))
    return left(
      new InvalidInputError('/discount', 'a discount cannot exceed what is being charged'),
    )
  if (totalOf(lines, charges, currency).isZero())
    return left(new InvalidInputError('/lines', 'a document that costs nothing commits nobody'))
  return right(lines)
}
