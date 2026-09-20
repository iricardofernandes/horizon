import { type Either, left, right } from '@/core/either'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import type { LotEntry, LotPick } from '@/domain/entities/lot-book'
import { Currency, Money, Note, Quantity } from '@/domain/value-objects/inventory-values'
import { ExpiryDate, LotCode } from '@/domain/value-objects/tracking'

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

/**
 * The lots a caller named, checked into value objects.
 *
 * Nothing here decides whether lots were *required* — that is the item's tracking policy,
 * and the balance is the thing that knows it. This only turns what arrived over the wire
 * into something the aggregate can reason about.
 */
export function lotEntriesOf(
  lots:
    | readonly { code: string; expiresOn?: string | null | undefined; quantity: string }[]
    | null
    | undefined,
  field = '/lots',
): Either<InvalidInputError, readonly LotEntry[] | null> {
  if (!lots) return right(null)
  const entries: LotEntry[] = []
  for (const [index, lot] of lots.entries()) {
    const code = LotCode.create(lot.code, `${field}/${index}/code`)
    if (code.isLeft()) return left(code.value)
    const quantity = Quantity.create(lot.quantity, `${field}/${index}/quantity`)
    if (quantity.isLeft()) return left(quantity.value)
    let expiresOn: ExpiryDate | null = null
    if (lot.expiresOn) {
      const parsed = ExpiryDate.create(lot.expiresOn, `${field}/${index}/expiresOn`)
      if (parsed.isLeft()) return left(parsed.value)
      expiresOn = parsed.value
    }
    entries.push({ code: code.value, expiresOn, quantity: quantity.value })
  }
  return right(entries)
}

/** Which lots to draw from, when the caller would rather choose than let the shelf. */
export function lotPicksOf(
  picks: readonly { code: string; quantity: string }[] | null | undefined,
  field = '/lots',
): Either<InvalidInputError, readonly LotPick[] | null> {
  if (!picks) return right(null)
  const chosen: LotPick[] = []
  for (const [index, pick] of picks.entries()) {
    const code = LotCode.create(pick.code, `${field}/${index}/code`)
    if (code.isLeft()) return left(code.value)
    const quantity = Quantity.create(pick.quantity, `${field}/${index}/quantity`)
    if (quantity.isLeft()) return left(quantity.value)
    chosen.push({ code: code.value, quantity: quantity.value })
  }
  return right(chosen)
}
