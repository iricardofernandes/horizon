import { type Either, left, right } from '@/core/either'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import type { RequisitionLine } from '@/domain/entities/purchase-requisition'
import type { Charges, PricedLineInput } from '@/domain/services/pricing'
import {
  BusinessDate,
  Currency,
  DocumentNumber,
  LineDescription,
  Memo,
  Money,
  PaymentTerms,
  Quantity,
  Reason,
} from '@/domain/value-objects/procurement-values'
import type { ProcurementScope } from '../ports/unit-of-work'

export interface LineInput {
  readonly lineId: string
  readonly itemId: string
  readonly description?: string | undefined
  readonly quantity: string
}

export interface PricedInput extends LineInput {
  readonly unitPrice: string
}

export interface ChargesInput {
  readonly tax?: string | undefined
  readonly freight?: string | undefined
  readonly otherCharges?: string | undefined
  readonly discount?: string | undefined
}

export function currencyOf(value: string): Either<InvalidInputError, Currency> {
  return Currency.create(value)
}

export function dateOf(value: string, field: string): Either<InvalidInputError, BusinessDate> {
  return BusinessDate.create(value, field)
}

export function reasonOf(value: string): Either<InvalidInputError, Reason> {
  return Reason.create(value)
}

export function memoOf(value: string | undefined, field = '/notes') {
  return Memo.create(value, field)
}

export function documentNumberOf(value: string) {
  return DocumentNumber.create(value)
}

export function paymentTermsOf(
  days: readonly number[] | undefined,
): Either<InvalidInputError, PaymentTerms> {
  return days === undefined ? right(PaymentTerms.immediate()) : PaymentTerms.create(days)
}

export function chargesOf(
  input: ChargesInput | undefined,
  currency: Currency,
): Either<InvalidInputError, Charges> {
  const fields = [
    ['tax', input?.tax],
    ['freight', input?.freight],
    ['otherCharges', input?.otherCharges],
    ['discount', input?.discount],
  ] as const
  const parsed: Record<string, Money> = {}
  for (const [name, value] of fields) {
    if (value === undefined) {
      parsed[name] = Money.zero(currency)
      continue
    }
    const money = Money.create(value, currency, `/${name}`)
    if (money.isLeft()) return left(money.value)
    parsed[name] = money.value
  }
  return right(parsed as unknown as Charges)
}

/**
 * Turn requested lines into domain lines, naming each item from the catalogue.
 *
 * The description defaults to what the catalogue calls the item and may be overridden,
 * because a buyer often has to say more than the catalogue does — a grade, a finish, a
 * specification the supplier needs. Either way the words are copied onto the document, so
 * a later rename in the catalogue never changes what was asked for.
 */
export async function requisitionLinesOf(
  scope: ProcurementScope,
  inputs: readonly LineInput[],
): Promise<Either<InvalidInputError | ResourceNotFoundError, readonly RequisitionLine[]>> {
  const lines: RequisitionLine[] = []
  for (const input of inputs) {
    const described = await describe(scope, input)
    if (described.isLeft()) return left(described.value)
    const quantity = Quantity.create(input.quantity, '/lines/quantity')
    if (quantity.isLeft()) return left(quantity.value)
    lines.push({
      lineId: input.lineId,
      itemId: input.itemId,
      description: described.value,
      quantity: quantity.value,
    })
  }
  return right(lines)
}

export async function pricedLinesOf(
  scope: ProcurementScope,
  inputs: readonly PricedInput[],
  currency: Currency,
): Promise<Either<InvalidInputError | ResourceNotFoundError, readonly PricedLineInput[]>> {
  const lines: PricedLineInput[] = []
  for (const input of inputs) {
    const described = await describe(scope, input)
    if (described.isLeft()) return left(described.value)
    const quantity = Quantity.create(input.quantity, '/lines/quantity')
    if (quantity.isLeft()) return left(quantity.value)
    const unitPrice = Money.create(input.unitPrice, currency, '/lines/unitPrice')
    if (unitPrice.isLeft()) return left(unitPrice.value)
    lines.push({
      lineId: input.lineId,
      itemId: input.itemId,
      description: described.value,
      quantity: quantity.value,
      unitPrice: unitPrice.value,
    })
  }
  return right(lines)
}

async function describe(
  scope: ProcurementScope,
  input: LineInput,
): Promise<Either<InvalidInputError | ResourceNotFoundError, LineDescription>> {
  if (input.description !== undefined) return LineDescription.create(input.description)
  const item = await scope.catalogItems.findById(input.itemId)
  if (!item)
    return left(
      new ResourceNotFoundError(`item ${input.itemId} is not in the catalogue; describe the line`),
    )
  return right(item.description)
}
