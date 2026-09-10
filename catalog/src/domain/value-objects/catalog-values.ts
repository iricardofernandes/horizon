import { type Either, left, right } from '@/core/either'
import { ValueObject } from '@/core/entities/value-object'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'

abstract class TextValue extends ValueObject<{ value: string }> {
  get value(): string {
    return this.props.value
  }
  protected componentsOf(): readonly unknown[] {
    return [this.value]
  }
}

export class CatalogName extends TextValue {
  static create(value: string, field = '/name'): Either<InvalidInputError, CatalogName> {
    const normalized = value.trim().replace(/\s+/g, ' ')
    if (normalized.length < 1 || normalized.length > 160)
      return left(new InvalidInputError(field, 'must contain between 1 and 160 characters'))
    return right(new CatalogName({ value: normalized }))
  }
}

export class Sku extends TextValue {
  static create(value: string): Either<InvalidInputError, Sku> {
    const normalized = value.trim().toUpperCase()
    if (!/^[A-Z0-9][A-Z0-9._/-]{0,63}$/.test(normalized))
      return left(
        new InvalidInputError(
          '/sku',
          'must contain 1 to 64 letters, digits, dots, dashes, slashes or underscores',
        ),
      )
    return right(new Sku({ value: normalized }))
  }
}

export class UnitCode extends TextValue {
  static create(value: string): Either<InvalidInputError, UnitCode> {
    const normalized = value.trim().toUpperCase()
    if (!/^[A-Z][A-Z0-9]{0,5}$/.test(normalized))
      return left(new InvalidInputError('/code', 'must contain 1 to 6 uppercase letters or digits'))
    return right(new UnitCode({ value: normalized }))
  }
}

export class NcmCode extends TextValue {
  static create(value: string, field = '/ncm'): Either<InvalidInputError, NcmCode> {
    const normalized = value.replace(/[.\s]/g, '')
    if (!/^\d{8}$/.test(normalized))
      return left(new InvalidInputError(field, 'must contain exactly 8 digits'))
    return right(new NcmCode({ value: normalized }))
  }
}

export class Currency extends TextValue {
  static create(value: string): Either<InvalidInputError, Currency> {
    const normalized = value.trim().toUpperCase()
    if (!/^[A-Z]{3}$/.test(normalized))
      return left(new InvalidInputError('/currency', 'must be a three-letter ISO 4217 code'))
    return right(new Currency({ value: normalized }))
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
