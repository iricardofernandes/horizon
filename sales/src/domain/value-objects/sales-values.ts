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
  minus(other: Money): Money {
    if (!this.currency.equals(other.currency)) throw new RangeError('money currencies differ')
    return Money.fromAmount(this.amount - other.amount, this.currency)
  }
  multiply(quantity: Quantity): Money {
    const rounded = (this.amount * quantity.micros + SCALE / 2n) / SCALE
    return Money.fromAmount(rounded, this.currency)
  }
  isZero(): boolean {
    return this.amount === 0n
  }
  isLessThan(other: Money): boolean {
    if (!this.currency.equals(other.currency)) throw new RangeError('money currencies differ')
    return this.amount < other.amount
  }
  /**
   * Divide into equal parts without losing or inventing a minor unit (ADR 0010). Each part
   * gets its floor and the units left over go one each to the earliest parts, so the result
   * is deterministic and always adds back up to the total.
   */
  split(parts: number): Money[] {
    if (parts < 1) throw new RangeError('money is split into at least one part')
    const count = BigInt(parts)
    const floor = this.amount / count
    let leftover = this.amount - floor * count
    return Array.from({ length: parts }, () => {
      const extra = leftover > 0n ? 1n : 0n
      leftover -= extra
      return Money.fromAmount(floor + extra, this.currency)
    })
  }
  /** What share of `whole` this is, in basis points, rounded half-up. */
  basisPointsOf(whole: Money): number {
    if (whole.isZero()) return 0
    return Number((this.amount * 20_000n + whole.amount) / (whole.amount * 2n))
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

export class Reason extends ValueObject<{ value: string }> {
  static create(value: string, field = '/reason'): Either<InvalidInputError, Reason> {
    const normalized = value.trim().replace(/\s+/g, ' ')
    if (normalized.length < 1 || normalized.length > 500)
      return left(new InvalidInputError(field, 'must contain between 1 and 500 characters'))
    return right(new Reason({ value: normalized }))
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

/** A calendar date with no time and no zone (ADR 0043). */
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
  static of(instant: Date): BusinessDate {
    return new BusinessDate({ value: instant.toISOString().slice(0, 10) })
  }
  get value(): string {
    return this.props.value
  }
  plusDays(days: number): BusinessDate {
    const moved = new Date(`${this.value}T00:00:00Z`)
    moved.setUTCDate(moved.getUTCDate() + days)
    return new BusinessDate({ value: moved.toISOString().slice(0, 10) })
  }
  protected componentsOf(): readonly unknown[] {
    return [this.value]
  }
}

const MAX_PAYMENT_TERM_DAYS = 365
const MAX_INSTALLMENTS = 12

/**
 * When the customer has agreed to pay, as days after the order is issued — `30/60/90`.
 *
 * Days rather than dates because the terms are agreed before anyone knows which day the
 * order will be issued on. The dates are derived when the receivable is raised, which is
 * the only moment they matter.
 */
export class PaymentTerms extends ValueObject<{ days: readonly number[] }> {
  static create(
    days: readonly number[],
    field = '/paymentTermDays',
  ): Either<InvalidInputError, PaymentTerms> {
    if (days.length === 0)
      return left(new InvalidInputError(field, 'must contain at least one installment'))
    if (days.length > MAX_INSTALLMENTS)
      return left(
        new InvalidInputError(field, `must contain at most ${MAX_INSTALLMENTS} installments`),
      )
    if (days.some((day) => !Number.isInteger(day) || day < 0 || day > MAX_PAYMENT_TERM_DAYS))
      return left(
        new InvalidInputError(
          field,
          `each installment falls 0 to ${MAX_PAYMENT_TERM_DAYS} days out`,
        ),
      )
    if (days.some((day, index) => index > 0 && day <= (days[index - 1] ?? 0)))
      return left(new InvalidInputError(field, 'installments must be in increasing order of days'))
    return right(new PaymentTerms({ days: [...days] }))
  }

  /** On delivery, the terms of an order nobody agreed anything else for. */
  static immediate(): PaymentTerms {
    return new PaymentTerms({ days: [0] })
  }

  get days(): readonly number[] {
    return this.props.days
  }

  /** The total split evenly across the terms, each part dated from `issuedOn`. */
  scheduleOf(
    total: Money,
    issuedOn: BusinessDate,
  ): readonly { readonly number: number; readonly dueOn: BusinessDate; readonly amount: Money }[] {
    const parts = total.split(this.props.days.length)
    return this.props.days.map((day, index) => ({
      number: index + 1,
      dueOn: issuedOn.plusDays(day),
      amount: parts[index] ?? Money.fromAmount(0n, total.currency),
    }))
  }

  protected componentsOf(): readonly unknown[] {
    return this.props.days
  }
}

/** Who is carrying the goods. Free text: a carrier is not a party the registry knows yet. */
export class CarrierName extends ValueObject<{ value: string }> {
  static create(value: string): Either<InvalidInputError, CarrierName> {
    const normalized = value.trim().replace(/\s+/g, ' ')
    if (normalized.length < 2 || normalized.length > 120)
      return left(new InvalidInputError('/carrier', 'must contain between 2 and 120 characters'))
    return right(new CarrierName({ value: normalized }))
  }
  get value(): string {
    return this.props.value
  }
  protected componentsOf(): readonly unknown[] {
    return [this.value]
  }
}
