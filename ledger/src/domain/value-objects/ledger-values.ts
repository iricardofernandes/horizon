import { type Either, left, right } from '@/core/either'
import { ValueObject } from '@/core/entities/value-object'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'

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

  get amount(): bigint {
    return this.props.amount
  }

  get currency(): Currency {
    return this.props.currency
  }

  isZero(): boolean {
    return this.amount === 0n
  }

  protected componentsOf(): readonly unknown[] {
    return [this.amount, this.currency.value]
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

  get value(): string {
    return this.props.value
  }

  isBefore(other: BusinessDate): boolean {
    return this.value < other.value
  }

  protected componentsOf(): readonly unknown[] {
    return [this.value]
  }
}

/**
 * The calendar month a transaction belongs to, `YYYY-MM`.
 *
 * A ledger opens and closes months, not arbitrary ranges, so the period is derived from
 * the posting date rather than chosen: the two can never disagree about which month a
 * transaction landed in.
 */
export class Period extends ValueObject<{ value: string }> {
  static create(value: string, field = '/period'): Either<InvalidInputError, Period> {
    const trimmed = value.trim()
    if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(trimmed))
      return left(new InvalidInputError(field, 'must be a calendar month as YYYY-MM'))
    return right(new Period({ value: trimmed }))
  }

  static of(date: BusinessDate): Period {
    return new Period({ value: date.value.slice(0, 7) })
  }

  get value(): string {
    return this.props.value
  }

  protected componentsOf(): readonly unknown[] {
    return [this.value]
  }
}

/**
 * A dotted numeric account code — `1`, `1.01`, `1.01.001`.
 *
 * The dots are the hierarchy: `1.01.001` is a child of `1.01` and nothing else. Keeping
 * the tree in the code rather than only in a parent column means a mis-parented account
 * is a validation error at the moment it is opened, not a reporting mystery later.
 */
export class AccountCode extends ValueObject<{ value: string }> {
  static create(value: string, field = '/code'): Either<InvalidInputError, AccountCode> {
    const trimmed = value.trim()
    if (!/^\d{1,3}(?:\.\d{1,3}){0,4}$/.test(trimmed))
      return left(
        new InvalidInputError(field, 'must be up to five dot-separated groups of 1 to 3 digits'),
      )
    return right(new AccountCode({ value: trimmed }))
  }

  get value(): string {
    return this.props.value
  }

  get depth(): number {
    return this.props.value.split('.').length
  }

  isChildOf(parent: AccountCode): boolean {
    return this.depth === parent.depth + 1 && this.value.startsWith(`${parent.value}.`)
  }

  protected componentsOf(): readonly unknown[] {
    return [this.value]
  }
}

function text(
  value: string,
  field: string,
  min: number,
  max: number,
): Either<InvalidInputError, string> {
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (normalized.length < min || normalized.length > max)
    return left(new InvalidInputError(field, `must contain between ${min} and ${max} characters`))
  return right(normalized)
}

export class AccountName extends ValueObject<{ value: string }> {
  static create(value: string): Either<InvalidInputError, AccountName> {
    const parsed = text(value, '/name', 2, 120)
    return parsed.isLeft() ? left(parsed.value) : right(new AccountName({ value: parsed.value }))
  }
  get value(): string {
    return this.props.value
  }
  protected componentsOf(): readonly unknown[] {
    return [this.value]
  }
}

/** What the transaction is about in the world: an invoice number, a contract, a payslip. */
export class Reference extends ValueObject<{ value: string }> {
  static create(value: string): Either<InvalidInputError, Reference> {
    const parsed = text(value, '/reference', 1, 60)
    return parsed.isLeft() ? left(parsed.value) : right(new Reference({ value: parsed.value }))
  }
  get value(): string {
    return this.props.value
  }
  protected componentsOf(): readonly unknown[] {
    return [this.value]
  }
}

/** Optional free text on a transaction or one of its lines. */
export class Memo extends ValueObject<{ value: string }> {
  static create(value: string | undefined, field: string): Either<InvalidInputError, Memo | null> {
    if (value === undefined || value.trim() === '') return right(null)
    const parsed = text(value, field, 1, 200)
    return parsed.isLeft() ? left(parsed.value) : right(new Memo({ value: parsed.value }))
  }
  get value(): string {
    return this.props.value
  }
  protected componentsOf(): readonly unknown[] {
    return [this.value]
  }
}

/** Why something was undone. Required, and kept (ADR 0042). */
export class Reason extends ValueObject<{ value: string }> {
  static create(value: string): Either<InvalidInputError, Reason> {
    const parsed = text(value, '/reason', 3, 500)
    return parsed.isLeft() ? left(parsed.value) : right(new Reason({ value: parsed.value }))
  }
  get value(): string {
    return this.props.value
  }
  protected componentsOf(): readonly unknown[] {
    return [this.value]
  }
}
