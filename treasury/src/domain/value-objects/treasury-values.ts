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

/** Optional free text on an entry: who paid, what for. */
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

/**
 * Where a bank account lives: the Brazilian clearing code (COMPE, three digits), branch
 * and account number. Kept as text — leading zeros and check digits are part of them.
 */
export class BankDetails extends ValueObject<{
  bankCode: string
  branch: string
  accountNumber: string
}> {
  static create(input: {
    bankCode: string
    branch: string
    accountNumber: string
  }): Either<InvalidInputError, BankDetails> {
    const bankCode = input.bankCode.trim()
    if (!/^\d{3}$/.test(bankCode))
      return left(new InvalidInputError('/bank/bankCode', 'must be a three-digit bank code'))
    const branch = input.branch.trim()
    if (!/^[0-9A-Za-z-]{1,10}$/.test(branch))
      return left(
        new InvalidInputError('/bank/branch', 'must be 1 to 10 digits, letters or dashes'),
      )
    const accountNumber = input.accountNumber.trim()
    if (!/^[0-9A-Za-z-]{1,20}$/.test(accountNumber))
      return left(
        new InvalidInputError('/bank/accountNumber', 'must be 1 to 20 digits, letters or dashes'),
      )
    return right(new BankDetails({ bankCode, branch, accountNumber }))
  }

  get bankCode(): string {
    return this.props.bankCode
  }
  get branch(): string {
    return this.props.branch
  }
  get accountNumber(): string {
    return this.props.accountNumber
  }

  protected componentsOf(): readonly unknown[] {
    return [this.bankCode, this.branch, this.accountNumber]
  }
}
