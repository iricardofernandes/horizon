import { type Either, left, right } from '@/core/either'
import { ValueObject } from '@/core/entities/value-object'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'

const SCALE = 1_000_000n

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

/** Integer minor units with an explicit currency, never negative (ADR 0010). */
export class Money extends ValueObject<{ amount: bigint; currency: Currency }> {
  static create(
    amount: string,
    currency: Currency,
    field = '/amount',
  ): Either<InvalidInputError, Money> {
    if (!/^\d{1,18}$/.test(amount))
      return left(
        new InvalidInputError(field, 'must be a non-negative integer count of minor units'),
      )
    return right(new Money({ amount: BigInt(amount), currency }))
  }

  static of(amount: bigint, currency: Currency): Money {
    if (amount < 0n) throw new RangeError('money cannot be negative')
    return new Money({ amount, currency })
  }

  static zero(currency: Currency): Money {
    return new Money({ amount: 0n, currency })
  }

  get amount(): bigint {
    return this.props.amount
  }

  get currency(): Currency {
    return this.props.currency
  }

  isZero(): boolean {
    return this.amount === 0n
  }

  isLessThan(other: Money): boolean {
    this.sameCurrencyAs(other)
    return this.amount < other.amount
  }

  plus(other: Money): Money {
    this.sameCurrencyAs(other)
    return Money.of(this.amount + other.amount, this.currency)
  }

  minus(other: Money): Money {
    this.sameCurrencyAs(other)
    return Money.of(this.amount - other.amount, this.currency)
  }

  /** A unit price times a quantity, rounded half-up to the minor unit. */
  multiply(quantity: Quantity): Money {
    return Money.of((this.amount * quantity.micros + SCALE / 2n) / SCALE, this.currency)
  }

  /**
   * Divide into equal parts without losing or inventing a minor unit (ADR 0010).
   *
   * Each part gets its floor and the units left over go one each to the earliest parts, so
   * the result is deterministic and always adds back up to the total.
   */
  split(parts: number): Money[] {
    if (parts < 1) throw new RangeError('money is split into at least one part')
    const count = BigInt(parts)
    const floor = this.amount / count
    let leftover = this.amount - floor * count
    return Array.from({ length: parts }, () => {
      const extra = leftover > 0n ? 1n : 0n
      leftover -= extra
      return Money.of(floor + extra, this.currency)
    })
  }

  protected componentsOf(): readonly unknown[] {
    return [this.amount, this.currency.value]
  }

  private sameCurrencyAs(other: Money): void {
    if (!this.currency.equals(other.currency)) throw new RangeError('money currencies differ')
  }
}

/** A non-negative decimal quantity with at most six places, held as integer micros. */
export class Quantity extends ValueObject<{ micros: bigint }> {
  static create(value: string, field = '/quantity'): Either<InvalidInputError, Quantity> {
    if (!/^\d{1,15}(\.\d{1,6})?$/.test(value))
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

  isBefore(other: BusinessDate): boolean {
    return this.value < other.value
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

/**
 * The supplier's own identifier for a document — its quotation number, its order
 * acknowledgement. It is whatever the supplier calls it, so it is text rather than a
 * pattern, and it exists so a person can find the paper behind the record.
 */
export class DocumentNumber extends ValueObject<{ value: string }> {
  static create(
    value: string,
    field = '/documentNumber',
  ): Either<InvalidInputError, DocumentNumber> {
    const normalized = value.trim().replace(/\s+/g, ' ')
    if (normalized.length < 1 || normalized.length > 40)
      return left(new InvalidInputError(field, 'must contain between 1 and 40 characters'))
    return right(new DocumentNumber({ value: normalized }))
  }
  get value(): string {
    return this.props.value
  }
  protected componentsOf(): readonly unknown[] {
    return [this.value]
  }
}

/** A supplier's legal name, as the shared registry published it (ADR 0040). */
export class PartyName extends ValueObject<{ value: string }> {
  static create(value: string, field = '/name'): Either<InvalidInputError, PartyName> {
    const normalized = value.trim().replace(/\s+/g, ' ')
    if (normalized.length < 2 || normalized.length > 160)
      return left(new InvalidInputError(field, 'must contain between 2 and 160 characters'))
    return right(new PartyName({ value: normalized }))
  }
  get value(): string {
    return this.props.value
  }
  protected componentsOf(): readonly unknown[] {
    return [this.value]
  }
}

/**
 * What the line is for, in the buyer's words.
 *
 * It is snapshotted onto an approved order rather than read from the catalogue at display
 * time, because what the supplier agreed to supply is what the order said on the day, and
 * renaming an item later must not rewrite history.
 */
export class LineDescription extends ValueObject<{ value: string }> {
  static create(value: string, field = '/description'): Either<InvalidInputError, LineDescription> {
    const normalized = value.trim().replace(/\s+/g, ' ')
    if (normalized.length < 1 || normalized.length > 160)
      return left(new InvalidInputError(field, 'must contain between 1 and 160 characters'))
    return right(new LineDescription({ value: normalized }))
  }
  get value(): string {
    return this.props.value
  }
  protected componentsOf(): readonly unknown[] {
    return [this.value]
  }
}

export class Memo extends ValueObject<{ value: string }> {
  static create(
    value: string | undefined,
    field = '/memo',
  ): Either<InvalidInputError, Memo | null> {
    if (value === undefined) return right(null)
    const normalized = value.trim().replace(/\s+/g, ' ')
    if (normalized.length === 0) return right(null)
    if (normalized.length > 500)
      return left(new InvalidInputError(field, 'must contain at most 500 characters'))
    return right(new Memo({ value: normalized }))
  }
  get value(): string {
    return this.props.value
  }
  protected componentsOf(): readonly unknown[] {
    return [this.value]
  }
}

const MAX_PAYMENT_TERM_DAYS = 365
const MAX_INSTALLMENTS = 12

/**
 * When the supplier expects to be paid, as days after the order is issued — `30/60/90`.
 *
 * Days rather than dates because the terms are agreed before anyone knows which day the
 * order will be issued on, and they survive the order being issued later than planned. The
 * dates are derived when the payable is raised, which is the only moment they matter.
 */
export class PaymentTerms extends ValueObject<{ days: readonly number[] }> {
  static create(
    days: readonly number[],
    field = '/paymentTerms',
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

  /** Cash on delivery, the terms of an order nobody agreed anything else for. */
  static immediate(): PaymentTerms {
    return new PaymentTerms({ days: [0] })
  }

  get days(): readonly number[] {
    return this.props.days
  }

  get count(): number {
    return this.props.days.length
  }

  /** The total split evenly across the terms, each part dated from `issuedOn`. */
  scheduleOf(
    total: Money,
    issuedOn: BusinessDate,
  ): readonly { readonly dueOn: BusinessDate; readonly amount: Money }[] {
    const parts = total.split(this.props.days.length)
    return this.props.days.map((day, index) => ({
      dueOn: issuedOn.plusDays(day),
      amount: parts[index] ?? Money.zero(total.currency),
    }))
  }

  protected componentsOf(): readonly unknown[] {
    return this.props.days
  }
}

/** Why someone refused, cancelled or overrode something. Never optional where it applies. */
export class Reason extends ValueObject<{ value: string }> {
  static create(value: string, field = '/reason'): Either<InvalidInputError, Reason> {
    const normalized = value.trim().replace(/\s+/g, ' ')
    if (normalized.length < 3 || normalized.length > 300)
      return left(new InvalidInputError(field, 'must contain between 3 and 300 characters'))
    return right(new Reason({ value: normalized }))
  }
  get value(): string {
    return this.props.value
  }
  protected componentsOf(): readonly unknown[] {
    return [this.value]
  }
}
