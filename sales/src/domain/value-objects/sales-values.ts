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
  static create(amount: string, currency: Currency): Either<InvalidInputError, Money> {
    if (!/^\d+$/.test(amount))
      return left(
        new InvalidInputError('/amount', 'must be a non-negative integer count of minor units'),
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
  plus(other: Money): Money {
    if (!this.currency.equals(other.currency)) throw new RangeError('money currencies differ')
    return Money.fromAmount(this.amount + other.amount, this.currency)
  }
  multiply(quantity: Quantity): Money {
    const rounded = (this.amount * quantity.micros + SCALE / 2n) / SCALE
    return Money.fromAmount(rounded, this.currency)
  }
  protected componentsOf(): readonly unknown[] {
    return [this.amount, this.currency.value]
  }
}

export class LineDescription extends ValueObject<{ value: string }> {
  static create(value: string): Either<InvalidInputError, LineDescription> {
    const normalized = value.trim().replace(/\s+/g, ' ')
    if (normalized.length < 1 || normalized.length > 160)
      return left(
        new InvalidInputError('/description', 'must contain between 1 and 160 characters'),
      )
    return right(new LineDescription({ value: normalized }))
  }
  get value(): string {
    return this.props.value
  }
  protected componentsOf(): readonly unknown[] {
    return [this.value]
  }
}

export class CancellationReason extends ValueObject<{ value: string }> {
  static create(value: string): Either<InvalidInputError, CancellationReason> {
    const normalized = value.trim().replace(/\s+/g, ' ')
    if (normalized.length < 1 || normalized.length > 500)
      return left(new InvalidInputError('/reason', 'must contain between 1 and 500 characters'))
    return right(new CancellationReason({ value: normalized }))
  }
  get value(): string {
    return this.props.value
  }
  protected componentsOf(): readonly unknown[] {
    return [this.value]
  }
}

export class CustomerName extends ValueObject<{ value: string }> {
  static create(value: string): Either<InvalidInputError, CustomerName> {
    const normalized = value.trim().replace(/\s+/g, ' ')
    if (normalized.length < 2 || normalized.length > 160)
      return left(new InvalidInputError('/name', 'must contain between 2 and 160 characters'))
    return right(new CustomerName({ value: normalized }))
  }
  get value(): string {
    return this.props.value
  }
  protected componentsOf(): readonly unknown[] {
    return [this.value]
  }
}

export class TaxId extends ValueObject<{ value: string }> {
  static create(value: string): Either<InvalidInputError, TaxId> {
    const digits = value.replace(/\D/g, '')
    if (digits.length !== 11 && digits.length !== 14)
      return left(new InvalidInputError('/taxId', 'must be a CPF or CNPJ with 11 or 14 digits'))
    return right(new TaxId({ value: digits }))
  }
  get value(): string {
    return this.props.value
  }
  protected componentsOf(): readonly unknown[] {
    return [this.value]
  }
}

export class CustomerEmail extends ValueObject<{ value: string }> {
  static create(value: string): Either<InvalidInputError, CustomerEmail> {
    const normalized = value.trim().toLowerCase()
    if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized))
      return left(new InvalidInputError('/email', 'must be a valid email address'))
    return right(new CustomerEmail({ value: normalized }))
  }
  get value(): string {
    return this.props.value
  }
  protected componentsOf(): readonly unknown[] {
    return [this.value]
  }
}

export class CustomerPhone extends ValueObject<{ value: string }> {
  static create(value: string): Either<InvalidInputError, CustomerPhone> {
    const normalized = value.trim().replace(/[\s()-]/g, '')
    if (!/^\+?\d{8,15}$/.test(normalized))
      return left(new InvalidInputError('/phone', 'must contain 8 to 15 international digits'))
    return right(new CustomerPhone({ value: normalized }))
  }
  get value(): string {
    return this.props.value
  }
  protected componentsOf(): readonly unknown[] {
    return [this.value]
  }
}
