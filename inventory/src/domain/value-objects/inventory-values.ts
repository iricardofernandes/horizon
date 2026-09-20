import { type Either, left, right } from '@/core/either'
import { ValueObject } from '@/core/entities/value-object'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'

const SCALE = 1_000_000n

export class Quantity extends ValueObject<{ micros: bigint }> {
  static create(value: string, field = '/quantity'): Either<InvalidInputError, Quantity> {
    if (!/^\d+(\.\d{1,6})?$/.test(value))
      return left(
        new InvalidInputError(field, 'must be a non-negative decimal with at most 6 places'),
      )
    const [whole = '0', fraction = ''] = value.split('.')
    return right(new Quantity({ micros: BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, '0')) }))
  }
  static fromMicros(micros: bigint): Quantity {
    if (micros < 0n) throw new RangeError('quantity cannot be negative')
    return new Quantity({ micros })
  }
  get micros(): bigint {
    return this.props.micros
  }
  isZero(): boolean {
    return this.micros === 0n
  }
  isLessThan(other: Quantity): boolean {
    return this.micros < other.micros
  }
  plus(other: Quantity): Quantity {
    return Quantity.fromMicros(this.micros + other.micros)
  }
  minus(other: Quantity): Quantity {
    return Quantity.fromMicros(this.micros - other.micros)
  }
  override toString(): string {
    const whole = this.micros / SCALE
    const fraction = (this.micros % SCALE).toString().padStart(6, '0').replace(/0+$/, '')
    return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`
  }
  protected componentsOf(): readonly unknown[] {
    return [this.micros]
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

export class Money extends ValueObject<{ amount: bigint; currency: Currency }> {
  static create(
    amount: string,
    currency: Currency,
    field = '/amount',
  ): Either<InvalidInputError, Money> {
    if (!/^\d+$/.test(amount))
      return left(
        new InvalidInputError(field, 'must be a non-negative integer count of minor units'),
      )
    return right(new Money({ amount: BigInt(amount), currency }))
  }
  static fromAmount(amount: bigint, currency: Currency): Money {
    if (amount < 0n) throw new RangeError('money cannot be negative')
    return new Money({ amount, currency })
  }
  get amount(): bigint {
    return this.props.amount
  }
  get currency(): Currency {
    return this.props.currency
  }
  protected componentsOf(): readonly unknown[] {
    return [this.amount, this.currency.value]
  }
}

export class WarehouseName extends ValueObject<{ value: string }> {
  static create(value: string): Either<InvalidInputError, WarehouseName> {
    const normalized = value.trim().replace(/\s+/g, ' ')
    if (normalized.length < 1 || normalized.length > 120)
      return left(new InvalidInputError('/name', 'must contain between 1 and 120 characters'))
    return right(new WarehouseName({ value: normalized }))
  }
  get value(): string {
    return this.props.value
  }
  protected componentsOf(): readonly unknown[] {
    return [this.value]
  }
}

/**
 * A person's own words about why stock moved.
 *
 * The reason code says which of a handful of things happened; this says what actually
 * happened, and it is the only part of an adjustment a reader outside the warehouse can
 * learn anything from.
 */
export class Note extends ValueObject<{ value: string }> {
  static create(value: string, field = '/note'): Either<InvalidInputError, Note> {
    const normalized = value.trim().replace(/\s+/g, ' ')
    if (normalized.length < 1 || normalized.length > 500)
      return left(new InvalidInputError(field, 'must contain between 1 and 500 characters'))
    return right(new Note({ value: normalized }))
  }
  get value(): string {
    return this.props.value
  }
  protected componentsOf(): readonly unknown[] {
    return [this.value]
  }
}
