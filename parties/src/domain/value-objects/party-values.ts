import { type Either, left, right } from '@/core/either'
import { ValueObject } from '@/core/entities/value-object'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'

/** What a party is to the business. One party may be several of these at once. */
export const PARTY_ROLES = ['customer', 'supplier', 'carrier', 'prospect', 'partner'] as const
export type PartyRole = (typeof PARTY_ROLES)[number]

/** An organization or a natural person. It decides which tax identifier is valid. */
export const PARTY_KINDS = ['organization', 'person'] as const
export type PartyKind = (typeof PARTY_KINDS)[number]

export class PartyName extends ValueObject<{ value: string }> {
  static create(value: string, field = '/legalName'): Either<InvalidInputError, PartyName> {
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
 * A CPF or a CNPJ. The first twelve CNPJ positions may be alphanumeric;
 * its two check digits and every CPF position remain numeric.
 *
 * Uniqueness per tenant is enforced against a keyed blind index of this value rather than
 * the value itself, which is what allows "is this company already a supplier?" to be
 * answered without storing the identifier in the clear (ADR 0026).
 */
export class TaxId extends ValueObject<{ value: string }> {
  static create(value: string, kind?: PartyKind): Either<InvalidInputError, TaxId> {
    const canonical = value
      .trim()
      .toUpperCase()
      .replace(/[.\-/\s]/g, '')
    if (!/^(?:\d{11}|[A-Z0-9]{12}\d{2})$/.test(canonical))
      return left(
        new InvalidInputError(
          '/taxId',
          'must be an 11-digit CPF or a 14-character CNPJ with two check digits',
        ),
      )
    if (kind === 'person' && canonical.length !== 11)
      return left(new InvalidInputError('/taxId', 'a person is identified by an 11-digit CPF'))
    if (kind === 'organization' && canonical.length !== 14)
      return left(
        new InvalidInputError('/taxId', 'an organization is identified by a 14-character CNPJ'),
      )
    return right(new TaxId({ value: canonical }))
  }
  get value(): string {
    return this.props.value
  }
  protected componentsOf(): readonly unknown[] {
    return [this.value]
  }
}

export class PartyEmail extends ValueObject<{ value: string }> {
  static create(value: string): Either<InvalidInputError, PartyEmail> {
    const normalized = value.trim().toLowerCase()
    if (normalized.length > 254 || !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(normalized))
      return left(new InvalidInputError('/email', 'must be a valid email address'))
    return right(new PartyEmail({ value: normalized }))
  }
  get value(): string {
    return this.props.value
  }
  protected componentsOf(): readonly unknown[] {
    return [this.value]
  }
}

export class PartyPhone extends ValueObject<{ value: string }> {
  static create(value: string): Either<InvalidInputError, PartyPhone> {
    const normalized = value.trim().replace(/[\s().-]/g, '')
    if (!/^\+?\d{8,15}$/.test(normalized))
      return left(new InvalidInputError('/phone', 'must contain between 8 and 15 digits'))
    return right(new PartyPhone({ value: normalized }))
  }
  get value(): string {
    return this.props.value
  }
  protected componentsOf(): readonly unknown[] {
    return [this.value]
  }
}

export class PartyAddress extends ValueObject<{ value: string }> {
  static create(value: string): Either<InvalidInputError, PartyAddress> {
    const normalized = value.trim().replace(/\s+/g, ' ')
    if (normalized.length < 5 || normalized.length > 500)
      return left(new InvalidInputError('/address', 'must contain between 5 and 500 characters'))
    return right(new PartyAddress({ value: normalized }))
  }
  get value(): string {
    return this.props.value
  }
  protected componentsOf(): readonly unknown[] {
    return [this.value]
  }
}

/**
 * The roles a party holds, as a set (ADR 0040).
 *
 * A first-class collection rather than an array on the aggregate: the same company being
 * both a customer and a supplier is the ordinary case, and the rule that it cannot hold
 * the same role twice lives here rather than in every caller.
 */
export class PartyRoles extends ValueObject<{ readonly roles: readonly PartyRole[] }> {
  static of(roles: readonly string[]): Either<InvalidInputError, PartyRoles> {
    const unknown = roles.find((role) => !PARTY_ROLES.includes(role as PartyRole))
    if (unknown !== undefined)
      return left(new InvalidInputError('/roles', `"${unknown}" is not a party role`))
    return right(new PartyRoles({ roles: PartyRoles.canonical(roles as readonly PartyRole[]) }))
  }

  private static canonical(roles: readonly PartyRole[]): readonly PartyRole[] {
    return [...new Set(roles)].sort()
  }

  get values(): readonly PartyRole[] {
    return this.props.roles
  }

  get isEmpty(): boolean {
    return this.props.roles.length === 0
  }

  has(role: PartyRole): boolean {
    return this.props.roles.includes(role)
  }

  with(role: PartyRole): PartyRoles {
    return new PartyRoles({ roles: PartyRoles.canonical([...this.props.roles, role]) })
  }

  without(role: PartyRole): PartyRoles {
    return new PartyRoles({ roles: this.props.roles.filter((held) => held !== role) })
  }

  protected componentsOf(): readonly unknown[] {
    return [this.props.roles.join(',')]
  }
}
