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

/**
 * What a combination is built out of, so nothing a person types can be spelled to look
 * like the separators that hold one together.
 */
const CONTROL_CHARACTERS = /\p{Cc}/u

/**
 * One axis a family's variants differ along: "size", "colour".
 *
 * Case-folded for comparison but kept as written for display, because a catalogue that
 * turned "Colour" into "colour" on screen would be correcting its owner's spelling.
 */
export class AttributeName extends TextValue {
  static create(value: string, field = '/attribute'): Either<InvalidInputError, AttributeName> {
    const normalized = value.trim().replace(/\s+/g, ' ')
    if (normalized.length < 1 || normalized.length > 60)
      return left(new InvalidInputError(field, 'must contain between 1 and 60 characters'))
    if (CONTROL_CHARACTERS.test(normalized))
      return left(new InvalidInputError(field, 'must not contain control characters'))
    return right(new AttributeName({ value: normalized }))
  }
  /** What makes two names the same name, whatever case anybody typed. */
  get key(): string {
    return this.value.toLocaleLowerCase()
  }
}

/** What one variant answers for one axis: "L", "navy blue". */
export class AttributeValue extends TextValue {
  static create(value: string, field = '/value'): Either<InvalidInputError, AttributeValue> {
    const normalized = value.trim().replace(/\s+/g, ' ')
    if (normalized.length < 1 || normalized.length > 120)
      return left(new InvalidInputError(field, 'must contain between 1 and 120 characters'))
    if (CONTROL_CHARACTERS.test(normalized))
      return left(new InvalidInputError(field, 'must not contain control characters'))
    return right(new AttributeValue({ value: normalized }))
  }
  get key(): string {
    return this.value.toLocaleLowerCase()
  }
}

const SCALE = 1_000_000n

/**
 * How much of a component goes into one of the parent.
 *
 * Six decimal places, the same as the quantities Inventory moves: a recipe that asked for
 * more precision than the warehouse can count would be a recipe nobody could follow.
 */
export class ComponentQuantity extends ValueObject<{ micros: bigint }> {
  static create(value: string, field = '/quantity'): Either<InvalidInputError, ComponentQuantity> {
    if (!/^\d+(\.\d{1,6})?$/.test(value))
      return left(
        new InvalidInputError(field, 'must be a non-negative decimal with at most 6 places'),
      )
    const [whole = '0', fraction = ''] = value.split('.')
    const micros = BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, '0'))
    if (micros === 0n)
      return left(new InvalidInputError(field, 'must be more than none of the component'))
    return right(new ComponentQuantity({ micros }))
  }
  static fromMicros(micros: bigint): ComponentQuantity {
    return new ComponentQuantity({ micros })
  }
  get micros(): bigint {
    return this.props.micros
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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** The day a version of a recipe starts applying. */
export class EffectiveDate extends TextValue {
  static create(value: string, field = '/effectiveFrom'): Either<InvalidInputError, EffectiveDate> {
    if (
      !ISO_DATE.test(value) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
    )
      return left(new InvalidInputError(field, 'must be a calendar date as YYYY-MM-DD'))
    return right(new EffectiveDate({ value }))
  }
  isBefore(other: EffectiveDate): boolean {
    return this.value < other.value
  }
}
