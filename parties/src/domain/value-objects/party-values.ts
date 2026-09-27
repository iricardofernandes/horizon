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

/** How a party is identified (ADR 0057). `none` is a party that has not given one yet. */
export const PARTY_DOCUMENT_TYPES = ['cpf', 'cnpj', 'foreign', 'none'] as const
export type PartyDocumentType = (typeof PARTY_DOCUMENT_TYPES)[number]

export type PartyDocumentInput =
  | { readonly type: 'cpf' | 'cnpj'; readonly number: string }
  | { readonly type: 'foreign'; readonly country: string; readonly number: string }
  | { readonly type: 'none' }

/** The roles whose consumers need a way to reach the party and an address (ADR 0057). */
export const CONTACT_ROLES: readonly PartyRole[] = ['customer', 'supplier', 'carrier']

function canonicalNumber(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[.\-/\s]/g, '')
}

/**
 * A CPF, a CNPJ, a foreign identifier with its country, or nothing yet.
 *
 * The first twelve CNPJ positions may be alphanumeric; its two check digits and every CPF
 * position remain numeric. A CPF identifies a person and a CNPJ an organization; a foreign
 * identifier or no document may belong to either.
 *
 * Uniqueness per tenant is enforced against a keyed blind index of `indexInput` rather
 * than the value itself, which is what allows "is this company already a supplier?" to be
 * answered without storing the identifier in the clear (ADR 0026). A CPF or CNPJ keeps the
 * index input it had before foreign documents existed, so no stored index is rewritten.
 */
export class PartyDocument extends ValueObject<{
  type: PartyDocumentType
  number: string | null
  country: string | null
}> {
  static none(): PartyDocument {
    return new PartyDocument({ type: 'none', number: null, country: null })
  }

  static create(
    input: PartyDocumentInput,
    kind?: PartyKind,
  ): Either<InvalidInputError, PartyDocument> {
    if (input.type === 'none') return right(PartyDocument.none())
    if (input.type === 'foreign') return PartyDocument.foreign(input.country, input.number)
    return PartyDocument.brazilian(input.type, input.number, kind)
  }

  private static foreign(
    country: string,
    number: string,
  ): Either<InvalidInputError, PartyDocument> {
    const code = country.trim().toUpperCase()
    if (!/^[A-Z]{2}$/.test(code))
      return left(new InvalidInputError('/document/country', 'must be a two-letter ISO country'))
    if (code === 'BR')
      return left(
        new InvalidInputError(
          '/document/country',
          'a Brazilian party is identified by CPF or CNPJ',
        ),
      )
    const canonical = number.trim().toUpperCase().replace(/\s+/g, ' ')
    if (!/^[A-Z0-9][A-Z0-9 ./-]{0,39}$/.test(canonical))
      return left(
        new InvalidInputError(
          '/document/number',
          'must contain 1 to 40 letters, digits, spaces, dots, dashes or slashes',
        ),
      )
    return right(new PartyDocument({ type: 'foreign', number: canonical, country: code }))
  }

  private static brazilian(
    type: 'cpf' | 'cnpj',
    value: string,
    kind?: PartyKind,
  ): Either<InvalidInputError, PartyDocument> {
    const number = canonicalNumber(value)
    const shape = type === 'cpf' ? /^\d{11}$/ : /^[A-Z0-9]{12}\d{2}$/
    if (!shape.test(number))
      return left(
        new InvalidInputError(
          '/document/number',
          type === 'cpf'
            ? 'a CPF has 11 digits'
            : 'a CNPJ has 14 characters, the last two numeric check digits',
        ),
      )
    const owner: PartyKind = type === 'cpf' ? 'person' : 'organization'
    if (kind !== undefined && kind !== owner)
      return left(
        new InvalidInputError(
          '/document/type',
          owner === 'person' ? 'a CPF identifies a person' : 'a CNPJ identifies an organization',
        ),
      )
    return right(new PartyDocument({ type, number, country: null }))
  }

  /** The pre-Phase 54 shorthand: an 11-digit CPF or a 14-character CNPJ, paired with the kind. */
  static fromTaxId(value: string, kind?: PartyKind): Either<InvalidInputError, PartyDocument> {
    const canonical = canonicalNumber(value)
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
    return PartyDocument.create({
      type: canonical.length === 11 ? 'cpf' : 'cnpj',
      number: canonical,
    })
  }

  get type(): PartyDocumentType {
    return this.props.type
  }

  get number(): string | null {
    return this.props.number
  }

  get country(): string | null {
    return this.props.country
  }

  /** A CPF or a CNPJ: what a Brazilian fiscal document can name as its recipient. */
  isBrazilian(): boolean {
    return this.props.type === 'cpf' || this.props.type === 'cnpj'
  }

  /** What the uniqueness index is computed from; a party without a document has none. */
  get indexInput(): string | null {
    return PartyDocument.indexInputOf(this.props)
  }

  static indexInputOf(document: {
    readonly type: PartyDocumentType
    readonly number: string | null
    readonly country: string | null
  }): string | null {
    if (document.type === 'none' || document.number === null) return null
    if (document.type === 'foreign') return `foreign:${document.country}:${document.number}`
    return document.number
  }

  protected componentsOf(): readonly unknown[] {
    return [this.props.type, this.props.number, this.props.country]
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
