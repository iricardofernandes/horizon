import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import {
  PartyErasedEvent,
  PartyFiscalProfileChangedEvent,
  PartyRegisteredEvent,
  PartyRoleChangedEvent,
  PartyUpdatedEvent,
} from '../events/party-events'
import type { FiscalProfile, FiscalProfileData } from '../value-objects/fiscal-profile'
import type { LookupProbe } from '../value-objects/party-lookup'
import {
  CONTACT_ROLES,
  type PartyAddress,
  type PartyDocument,
  type PartyDocumentType,
  type PartyEmail,
  type PartyKind,
  type PartyName,
  type PartyPhone,
  type PartyRole,
  type PartyRoles,
} from '../value-objects/party-values'

export type PartyStatus = 'active' | 'inactive' | 'erased'

interface PartyProps {
  tenantId: string
  kind: PartyKind
  legalName: PartyName
  tradeName: PartyName | null
  document: PartyDocument
  email: PartyEmail | null
  phone: PartyPhone | null
  address: PartyAddress | null
  fiscalProfile: FiscalProfile | null
  fiscalProfileRevision: number
  roles: PartyRoles
  status: PartyStatus
  createdAt: Date
  updatedAt: Date
}

export interface PartySnapshot {
  readonly id: string
  readonly tenantId: string
  readonly kind: PartyKind
  readonly legalName: string
  readonly tradeName: string | null
  readonly document: {
    readonly type: PartyDocumentType
    readonly number: string | null
    readonly country: string | null
  }
  readonly email: string | null
  readonly phone: string | null
  readonly address: string | null
  readonly fiscalProfile: Readonly<FiscalProfileData> | null
  readonly fiscalProfileRevision: number
  readonly roles: readonly PartyRole[]
  readonly status: PartyStatus
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface PartyContactDetails {
  readonly email: PartyEmail | null
  readonly phone: PartyPhone | null
  readonly address: PartyAddress | null
}

/**
 * The roles whose consumers print or ship to the party need all three contact fields; a
 * prospect or a partner may be known by name alone (ADR 0057).
 */
function contactGap(roles: readonly PartyRole[], contact: PartyContactDetails): string | null {
  const role = roles.find((held) => CONTACT_ROLES.includes(held))
  if (!role) return null
  const missing = (['email', 'phone', 'address'] as const).filter((field) => !contact[field])
  return missing.length ? `a ${role} needs ${missing.join(', ')}` : null
}

/**
 * An organization or a person the business deals with, holding the roles it plays.
 *
 * One party, at most one document, many roles (ADR 0040, ADR 0057). The same company being
 * a customer and a supplier is not two records that happen to match: it is one record with
 * two roles, which is what makes netting, statements and party-level reporting possible.
 */
export class Party extends AggregateRoot<PartyProps> {
  static register(
    props: Omit<
      PartyProps,
      'status' | 'createdAt' | 'updatedAt' | 'fiscalProfile' | 'fiscalProfileRevision'
    > & { now: Date },
    id?: UniqueEntityID,
  ): Either<InvalidInputError, Party> {
    const gap = contactGap(props.roles.values, props)
    if (gap) return left(new InvalidInputError('/roles', gap))
    const party = new Party(
      {
        tenantId: props.tenantId,
        kind: props.kind,
        legalName: props.legalName,
        tradeName: props.tradeName,
        document: props.document,
        email: props.email,
        phone: props.phone,
        address: props.address,
        fiscalProfile: null,
        fiscalProfileRevision: 0,
        roles: props.roles,
        status: 'active',
        createdAt: props.now,
        updatedAt: props.now,
      },
      id,
    )
    party.addDomainEvent(
      new PartyRegisteredEvent(
        party.id,
        props.tenantId,
        {
          kind: props.kind,
          legalName: props.legalName.value,
          tradeName: props.tradeName?.value ?? null,
          email: props.email?.value ?? null,
          phone: props.phone?.value ?? null,
          address: props.address?.value ?? null,
          documentType: props.document.type,
          documentCountry: props.document.country,
          roles: props.roles.values,
        },
        props.now,
      ),
    )
    return right(party)
  }

  static rehydrate(props: PartyProps, id: UniqueEntityID): Party {
    return new Party(props, id)
  }

  belongsTo(tenantId: string): boolean {
    return this.props.tenantId === tenantId
  }

  isActive(): boolean {
    return this.props.status === 'active'
  }

  isErased(): boolean {
    return this.props.status === 'erased'
  }

  holds(role: PartyRole): boolean {
    return this.props.roles.has(role)
  }

  document(): PartyDocument {
    return this.props.document
  }

  /** What a duplicate check compares this party by (ADR 0057). */
  lookupProbe(): LookupProbe {
    return {
      legalName: this.props.legalName.value,
      email: this.props.email?.value ?? null,
      phone: this.props.phone?.value ?? null,
    }
  }

  describe(
    details: { legalName: PartyName; tradeName: PartyName | null } & PartyContactDetails,
    now: Date,
  ): Either<ConflictError | InvalidInputError, void> {
    if (this.props.status === 'erased')
      return left(new ConflictError('an erased party cannot be edited'))
    const gap = contactGap(this.props.roles.values, details)
    if (gap) return left(new InvalidInputError('/roles', gap))
    this.props.legalName = details.legalName
    this.props.tradeName = details.tradeName
    this.props.email = details.email
    this.props.phone = details.phone
    this.props.address = details.address
    this.props.updatedAt = now
    this.announceUpdate(now)
    return right(undefined)
  }

  /**
   * A party registered without a document gives one later. Only then: replacing a document
   * would describe a different party, not correct this one (ADR 0057).
   */
  identify(document: PartyDocument, now: Date): Either<ConflictError | InvalidInputError, void> {
    if (this.props.status === 'erased')
      return left(new ConflictError('an erased party cannot be identified'))
    if (this.props.document.type !== 'none')
      return left(new ConflictError('party already has a document; it cannot be replaced'))
    if (document.type === 'none')
      return left(new InvalidInputError('/document/type', 'a document is required'))
    if (document.type === 'cpf' && this.props.kind !== 'person')
      return left(
        new InvalidInputError('/document/type', 'an organization is identified by a CNPJ'),
      )
    if (document.type === 'cnpj' && this.props.kind !== 'organization')
      return left(new InvalidInputError('/document/type', 'a person is identified by a CPF'))
    this.props.document = document
    this.props.updatedAt = now
    this.announceUpdate(now)
    return right(undefined)
  }

  describeFiscalProfile(profile: FiscalProfile, now: Date): Either<ConflictError, number> {
    if (this.props.status === 'erased')
      return left(new ConflictError('an erased party cannot have a fiscal profile'))
    if (!this.props.document.isBrazilian())
      return left(
        new ConflictError(
          'a fiscal profile needs a CPF or CNPJ; Brazilian fiscal documents to a foreign or undocumented party are not supported',
        ),
      )
    const previous = this.props.fiscalProfile?.details.effectiveFrom
    if (previous && profile.details.effectiveFrom < previous)
      return left(new ConflictError('a new fiscal profile cannot predate the current version'))
    this.props.fiscalProfile = profile
    this.props.fiscalProfileRevision += 1
    this.props.updatedAt = now
    this.addDomainEvent(
      new PartyFiscalProfileChangedEvent(
        this.id,
        this.props.tenantId,
        this.props.fiscalProfileRevision,
        profile.details.effectiveFrom,
        now,
      ),
    )
    return right(this.props.fiscalProfileRevision)
  }

  grant(role: PartyRole, now: Date): Either<ConflictError, void> {
    if (this.props.status === 'erased')
      return left(new ConflictError('an erased party cannot hold roles'))
    if (this.props.roles.has(role)) return left(new ConflictError(`party is already a ${role}`))
    const gap = contactGap([role], this.props)
    if (gap) return left(new ConflictError(`${gap} before it can be granted the role`))
    this.props.roles = this.props.roles.with(role)
    this.props.updatedAt = now
    this.addDomainEvent(
      new PartyRoleChangedEvent(
        this.id,
        this.props.tenantId,
        { role, operation: 'granted', roles: this.props.roles.values },
        now,
      ),
    )
    // Consumers that were not projecting this party yet need its details, not just the role.
    this.announceUpdate(now)
    return right(undefined)
  }

  /**
   * Revoking is not deleting: the party stays, and the documents it already signs for
   * keep their reference. A party left with no role is still a party, because the
   * relationship may resume.
   */
  revoke(role: PartyRole, now: Date): Either<ConflictError, void> {
    if (!this.props.roles.has(role)) return left(new ConflictError(`party is not a ${role}`))
    this.props.roles = this.props.roles.without(role)
    this.props.updatedAt = now
    this.addDomainEvent(
      new PartyRoleChangedEvent(
        this.id,
        this.props.tenantId,
        { role, operation: 'revoked', roles: this.props.roles.values },
        now,
      ),
    )
    // Consumers that were not projecting this party yet need its details, not just the role.
    this.announceUpdate(now)
    return right(undefined)
  }

  deactivate(now: Date): Either<ConflictError, void> {
    if (this.props.status !== 'active') return left(new ConflictError('party is not active'))
    this.props.status = 'inactive'
    this.props.updatedAt = now
    this.announceUpdate(now)
    return right(undefined)
  }

  reactivate(now: Date): Either<ConflictError, void> {
    if (this.props.status !== 'inactive') return left(new ConflictError('party is not inactive'))
    this.props.status = 'active'
    this.props.updatedAt = now
    this.announceUpdate(now)
    return right(undefined)
  }

  /**
   * Announce the party as it is, changing nothing, so a consumer that started after it was
   * registered can project it (a new module, a rebuilt projection). Every consumer treats
   * the update as a replacement, so a republish is harmless to those already in step.
   */
  republish(now: Date): Either<ConflictError, void> {
    if (this.props.status === 'erased')
      return left(new ConflictError('an erased party is not republished'))
    this.announceUpdate(now)
    return right(undefined)
  }

  /**
   * Crypto-shredding (ADR 0026). The aggregate records the fact; the repository destroys
   * the key material, and every projection is told to destroy its own copy.
   */
  erase(now: Date): Either<ConflictError, void> {
    if (this.props.status === 'erased') return left(new ConflictError('party is already erased'))
    this.props.status = 'erased'
    this.props.updatedAt = now
    this.addDomainEvent(new PartyErasedEvent(this.id, this.props.tenantId, now))
    return right(undefined)
  }

  private announceUpdate(now: Date): void {
    this.addDomainEvent(
      new PartyUpdatedEvent(
        this.id,
        this.props.tenantId,
        {
          kind: this.props.kind,
          legalName: this.props.legalName.value,
          tradeName: this.props.tradeName?.value ?? null,
          email: this.props.email?.value ?? null,
          phone: this.props.phone?.value ?? null,
          address: this.props.address?.value ?? null,
          documentType: this.props.document.type,
          documentCountry: this.props.document.country,
          roles: this.props.roles.values,
          active: this.props.status === 'active',
        },
        now,
      ),
    )
  }

  toSnapshot(): Readonly<PartySnapshot> {
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      kind: this.props.kind,
      legalName: this.props.legalName.value,
      tradeName: this.props.tradeName?.value ?? null,
      document: {
        type: this.props.document.type,
        number: this.props.document.number,
        country: this.props.document.country,
      },
      email: this.props.email?.value ?? null,
      phone: this.props.phone?.value ?? null,
      address: this.props.address?.value ?? null,
      fiscalProfile: this.props.fiscalProfile?.details ?? null,
      fiscalProfileRevision: this.props.fiscalProfileRevision,
      roles: this.props.roles.values,
      status: this.props.status,
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
    })
  }
}
