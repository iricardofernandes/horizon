import { type Either, left, right } from '@/core/either'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { Currency, Money, Note, Quantity } from '@/domain/value-objects/inventory-values'

/** Parsing the edge of the system once, so no use case reimplements it (ADR 0032). */

export const quantityOf = (value: string, field = '/quantity') => Quantity.create(value, field)

export const currencyOf = (value: string) => Currency.create(value)

export function noteOf(
  value: string | null | undefined,
  field = '/note',
): Either<InvalidInputError, Note | null> {
  if (value === null || value === undefined) return right(null)
  return Note.create(value, field)
}

export function moneyOf(
  amount: string,
  currency: string,
  field = '/unitCost',
): Either<InvalidInputError, Money> {
  const parsedCurrency = Currency.create(currency)
  if (parsedCurrency.isLeft()) return left(parsedCurrency.value)
  return Money.create(amount, parsedCurrency.value, field)
}

const MICROS = 1_000_000n

/**
 * What a quantity of something is worth, rounded half-up to the minor unit.
 *
 * Quantities carry six decimal places and unit costs are already integers of minor units,
 * so the product has to come back down to an integer somewhere. Doing it here, once,
 * keeps every allowance check comparing the same figure.
 */
export function worthOf(quantity: Quantity, unitCost: Money): Money {
  return Money.fromAmount(
    (quantity.micros * unitCost.amount + MICROS / 2n) / MICROS,
    unitCost.currency,
  )
}
