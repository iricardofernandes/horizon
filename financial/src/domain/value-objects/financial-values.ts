import { type Either, left, right } from '@/core/either'
import { ValueObject } from '@/core/entities/value-object'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'

/** A short identifier people type and reports sort by: `1.01`, `ADM`, `PRJ-2026`. */
export class Code extends ValueObject<{ value: string }> {
  static create(value: string, field = '/code'): Either<InvalidInputError, Code> {
    const normalized = value.trim().toUpperCase()
    if (!/^[A-Z0-9][A-Z0-9._-]{0,19}$/.test(normalized))
      return left(
        new InvalidInputError(
          field,
          'must be 1 to 20 letters, digits, dots, dashes or underscores',
        ),
      )
    return right(new Code({ value: normalized }))
  }
  get value(): string {
    return this.props.value
  }
  protected componentsOf(): readonly unknown[] {
    return [this.value]
  }
}

export class Name extends ValueObject<{ value: string }> {
  static create(value: string, field = '/name'): Either<InvalidInputError, Name> {
    const normalized = value.trim().replace(/\s+/g, ' ')
    if (normalized.length < 2 || normalized.length > 120)
      return left(new InvalidInputError(field, 'must contain between 2 and 120 characters'))
    return right(new Name({ value: normalized }))
  }
  get value(): string {
    return this.props.value
  }
  protected componentsOf(): readonly unknown[] {
    return [this.value]
  }
}

export const WHOLE = 10_000

/**
 * A share of a whole, in basis points: 10 000 is 100%. A scaled integer rather than a
 * float or a decimal string, so that shares add up exactly (ADR 0043).
 */
export class Share extends ValueObject<{ basisPoints: number }> {
  /** Accepts a percentage with at most two decimal places: `"33.33"`. */
  static fromPercentage(value: string, field = '/percentage'): Either<InvalidInputError, Share> {
    const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(value.trim())
    if (!match?.[1])
      return left(new InvalidInputError(field, 'must be a percentage with up to two decimals'))
    const basisPoints = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
    return Share.fromBasisPoints(basisPoints, field)
  }

  static fromBasisPoints(value: number, field = '/percentage'): Either<InvalidInputError, Share> {
    if (!Number.isInteger(value) || value < 1 || value > WHOLE)
      return left(new InvalidInputError(field, 'must be greater than 0% and at most 100%'))
    return right(new Share({ basisPoints: value }))
  }

  get basisPoints(): number {
    return this.props.basisPoints
  }

  toPercentage(): string {
    const whole = Math.trunc(this.basisPoints / 100)
    const fraction = String(this.basisPoints % 100).padStart(2, '0')
    return fraction === '00' ? String(whole) : `${whole}.${fraction.replace(/0$/, '')}`
  }

  protected componentsOf(): readonly unknown[] {
    return [this.basisPoints]
  }
}

export class Currency extends ValueObject<{ value: string }> {
  static create(value: string): Either<InvalidInputError, Currency> {
    const normalized = value.trim().toUpperCase()
    if (!/^[A-Z]{3}$/.test(normalized))
      return left(new InvalidInputError('/currency', 'must be a three-letter ISO 4217 code'))
    return right(new Currency({ value: normalized }))
  }
  get value(): string {
    return this.props.value
  }
  protected componentsOf(): readonly unknown[] {
    return [this.value]
  }
}

/** Integer minor units with an explicit currency, never negative (ADR 0010, ADR 0041). */
export class Money extends ValueObject<{ amount: bigint; currency: Currency }> {
  static create(amount: string, currency: Currency): Either<InvalidInputError, Money> {
    if (!/^\d{1,18}$/.test(amount))
      return left(
        new InvalidInputError('/amount', 'must be a non-negative integer count of minor units'),
      )
    return right(new Money({ amount: BigInt(amount), currency }))
  }

  static of(amount: bigint, currency: Currency): Money {
    if (amount < 0n) throw new RangeError('money cannot be negative')
    return new Money({ amount, currency })
  }

  get amount(): bigint {
    return this.props.amount
  }

  get currency(): Currency {
    return this.props.currency
  }

  /**
   * Divide by shares without losing or inventing a minor unit (ADR 0010). Each part gets
   * its floor; the units left over go, one each, to the parts with the largest remainders,
   * earliest first on a tie — so the result is deterministic and always sums to the total.
   */
  allocate(shares: readonly Share[]): Money[] {
    const whole = BigInt(WHOLE)
    const exact = shares.map((share) => this.amount * BigInt(share.basisPoints))
    const floors = exact.map((value) => value / whole)
    let leftover = this.amount - floors.reduce((sum, value) => sum + value, 0n)
    const order = exact
      .map((value, index) => ({ index, remainder: value % whole }))
      .sort((a, b) =>
        a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
      )
    const parts = [...floors]
    for (const { index } of order) {
      if (leftover === 0n) break
      parts[index] = (parts[index] ?? 0n) + 1n
      leftover -= 1n
    }
    return parts.map((part) => Money.of(part, this.currency))
  }

  protected componentsOf(): readonly unknown[] {
    return [this.amount, this.currency.value]
  }
}

/**
 * A calendar date with no time and no zone: a due date is due on the 10th wherever it is
 * read (ADR 0043). Arithmetic is done on UTC midnight, which has no daylight saving.
 */
export class BusinessDate extends ValueObject<{ value: string }> {
  static create(value: string, field = '/date'): Either<InvalidInputError, BusinessDate> {
    const trimmed = value.trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed))
      return left(new InvalidInputError(field, 'must be a calendar date as YYYY-MM-DD'))
    const parsed = new Date(`${trimmed}T00:00:00Z`)
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== trimmed)
      return left(new InvalidInputError(field, 'is not a real calendar date'))
    return right(new BusinessDate({ value: trimmed }))
  }

  get value(): string {
    return this.props.value
  }

  plusDays(days: number): BusinessDate {
    const date = new Date(`${this.value}T00:00:00Z`)
    date.setUTCDate(date.getUTCDate() + days)
    return new BusinessDate({ value: date.toISOString().slice(0, 10) })
  }

  protected componentsOf(): readonly unknown[] {
    return [this.value]
  }
}
