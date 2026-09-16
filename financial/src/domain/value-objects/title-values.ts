import { type Either, left, right } from '@/core/either'
import { ValueObject } from '@/core/entities/value-object'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'

/** The number printed on the document a title stands for: an invoice, a contract, a slip. */
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

/** Free text a person reads later; optional on a title, bounded everywhere. */
export class Memo extends ValueObject<{ value: string }> {
  static create(value: string, field = '/description'): Either<InvalidInputError, Memo | null> {
    const normalized = value.trim()
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

/**
 * Why a posted record was cancelled or reversed. Required, because a reversal nobody can
 * explain a year later is indistinguishable from tampering (ADR 0042).
 */
export class Reason extends ValueObject<{ value: string }> {
  static create(value: string, field = '/reason'): Either<InvalidInputError, Reason> {
    const normalized = value.trim().replace(/\s+/g, ' ')
    if (normalized.length < 3 || normalized.length > 500)
      return left(new InvalidInputError(field, 'must contain between 3 and 500 characters'))
    return right(new Reason({ value: normalized }))
  }
  get value(): string {
    return this.props.value
  }
  protected componentsOf(): readonly unknown[] {
    return [this.value]
  }
}
