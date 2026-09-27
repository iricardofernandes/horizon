import { type Either, left, right } from '@/core/either'
import { ValueObject } from '@/core/entities/value-object'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'

/** The party roles that make a party a CRM account (ADR 0057). */
export const ACCOUNT_ROLES = ['prospect', 'customer', 'partner'] as const
export type AccountRole = (typeof ACCOUNT_ROLES)[number]

export const PARTY_KINDS = ['organization', 'person'] as const
export type PartyKind = (typeof PARTY_KINDS)[number]

export const DOCUMENT_TYPES = ['cpf', 'cnpj', 'foreign', 'none'] as const
export type DocumentType = (typeof DOCUMENT_TYPES)[number]

/**
 * Why CRM may hold a contact's personal data (LGPD art. 7): the contract with the
 * account, the business's legitimate interest in the relationship, or the person's
 * consent. Recorded per contact, so an erasure or access request can be answered.
 */
export const LAWFUL_BASES = ['contract', 'legitimate-interest', 'consent'] as const
export type LawfulBasis = (typeof LAWFUL_BASES)[number]

function collapsed(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

/** A single-line text between bounds, reported against the field it came from. */
abstract class BoundedText extends ValueObject<{ value: string }> {
  protected static bounded(
    value: string,
    field: string,
    min: number,
    max: number,
  ): Either<InvalidInputError, string> {
    const normalized = collapsed(value)
    if (normalized.length < min || normalized.length > max)
      return left(new InvalidInputError(field, `must contain between ${min} and ${max} characters`))
    return right(normalized)
  }

  get value(): string {
    return this.props.value
  }

  protected componentsOf(): readonly unknown[] {
    return [this.props.value]
  }
}

/** How the business groups its accounts ("indústria", "varejo"): free text, one per account. */
export class Segment extends BoundedText {
  static create(value: string): Either<InvalidInputError, Segment> {
    const text = BoundedText.bounded(value, '/segment', 1, 80)
    return text.isLeft() ? left(text.value) : right(new Segment({ value: text.value }))
  }
}

const MAX_TAGS = 20

/** Labels on an account, as a set: lower-case, trimmed, at most twenty. */
export class Tags extends ValueObject<{ readonly values: readonly string[] }> {
  static of(values: readonly string[]): Either<InvalidInputError, Tags> {
    const normalized = [...new Set(values.map((value) => collapsed(value).toLowerCase()))]
    if (normalized.length > MAX_TAGS)
      return left(new InvalidInputError('/tags', `must contain at most ${MAX_TAGS} tags`))
    const invalid = normalized.find((tag) => tag.length < 1 || tag.length > 40)
    if (invalid !== undefined)
      return left(
        new InvalidInputError('/tags', 'each tag must contain between 1 and 40 characters'),
      )
    return right(new Tags({ values: normalized.sort() }))
  }

  static none(): Tags {
    return new Tags({ values: [] })
  }

  get values(): readonly string[] {
    return this.props.values
  }

  protected componentsOf(): readonly unknown[] {
    return [this.props.values.join('\u0000')]
  }
}

export class ContactName extends BoundedText {
  static create(value: string): Either<InvalidInputError, ContactName> {
    const text = BoundedText.bounded(value, '/name', 2, 160)
    return text.isLeft() ? left(text.value) : right(new ContactName({ value: text.value }))
  }
}

export class JobTitle extends BoundedText {
  static create(value: string): Either<InvalidInputError, JobTitle> {
    const text = BoundedText.bounded(value, '/jobTitle', 1, 120)
    return text.isLeft() ? left(text.value) : right(new JobTitle({ value: text.value }))
  }
}

export class ContactEmail extends ValueObject<{ value: string }> {
  static create(value: string): Either<InvalidInputError, ContactEmail> {
    const normalized = value.trim().toLowerCase()
    if (normalized.length > 254 || !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(normalized))
      return left(new InvalidInputError('/email', 'must be a valid email address'))
    return right(new ContactEmail({ value: normalized }))
  }

  get value(): string {
    return this.props.value
  }

  protected componentsOf(): readonly unknown[] {
    return [this.props.value]
  }
}

export class ContactPhone extends ValueObject<{ value: string }> {
  static create(value: string): Either<InvalidInputError, ContactPhone> {
    const normalized = value.trim().replace(/[\s().-]/g, '')
    if (!/^\+?\d{8,15}$/.test(normalized))
      return left(new InvalidInputError('/phone', 'must contain between 8 and 15 digits'))
    return right(new ContactPhone({ value: normalized }))
  }

  get value(): string {
    return this.props.value
  }

  protected componentsOf(): readonly unknown[] {
    return [this.props.value]
  }
}

export function lawfulBasisOf(value: string): Either<InvalidInputError, LawfulBasis> {
  return LAWFUL_BASES.includes(value as LawfulBasis)
    ? right(value as LawfulBasis)
    : left(new InvalidInputError('/lawfulBasis', `must be one of ${LAWFUL_BASES.join(', ')}`))
}

export function isAccountRole(role: string): role is AccountRole {
  return ACCOUNT_ROLES.includes(role as AccountRole)
}
