import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import {
  PartyErasedEvent,
  PartyFiscalProfileChangedEvent,
  PartyRegisteredEvent,
  PartyRoleChangedEvent,
  PartyUpdatedEvent,
} from '../events/party-events'
import type { FiscalProfile, FiscalProfileData } from '../value-objects/fiscal-profile'
import type {
  PartyAddress,
  PartyEmail,
  PartyKind,
  PartyName,
  PartyPhone,
  PartyRole,
  PartyRoles,
  TaxId,
} from '../value-objects/party-values'

export type PartyStatus = 'active' | 'inactive' | 'erased'

interface PartyProps {
  tenantId: string
  kind: PartyKind
  legalName: PartyName
  tradeName: PartyName | null
  taxId: TaxId
  email: PartyEmail
  phone: PartyPhone
  address: PartyAddress
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
  readonly taxId: string
  readonly email: string
  readonly phone: string
  readonly address: string
  readonly fiscalProfile: Readonly<FiscalProfileData> | null
  readonly fiscalProfileRevision: number
  readonly roles: readonly PartyRole[]
  readonly status: PartyStatus
  readonly createdAt: Date
  readonly updatedAt: Date
}

/**
 * An organization or a person the business deals with, holding the roles it plays.
 *
 * One party, one tax identifier, many roles (ADR 0040). The same company being a customer
 * and a supplier is not two records that happen to match: it is one record with two roles,
 * which is what makes netting, statements and party-level reporting possible later.
 */
export class Party extends AggregateRoot<PartyProps> {
  static register(
    props: Omit<
      PartyProps,
      'status' | 'createdAt' | 'updatedAt' | 'fiscalProfile' | 'fiscalProfileRevision'
    > & { now: Date },
    id?: UniqueEntityID,
  ): Party {
    const party = new Party(
      {
        tenantId: props.tenantId,
        kind: props.kind,
        legalName: props.legalName,
        tradeName: props.tradeName,
        taxId: props.taxId,
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
          email: props.email.value,
          phone: props.phone.value,
          address: props.address.value,
          roles: props.roles.values,
        },
        props.now,
      ),
    )
    return party
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

  describe(
    details: {
      legalName: PartyName
      tradeName: PartyName | null
      email: PartyEmail
      phone: PartyPhone
      address: PartyAddress
    },
    now: Date,
  ): Either<ConflictError, void> {
    if (this.props.status === 'erased')
      return left(new ConflictError('an erased party cannot be edited'))
    this.props.legalName = details.legalName
    this.props.tradeName = details.tradeName
    this.props.email = details.email
    this.props.phone = details.phone
    this.props.address = details.address
    this.props.updatedAt = now
    this.announceUpdate(now)
    return right(undefined)
  }

  describeFiscalProfile(profile: FiscalProfile, now: Date): Either<ConflictError, number> {
    if (this.props.status === 'erased')
      return left(new ConflictError('an erased party cannot have a fiscal profile'))
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
          legalName: this.props.legalName.value,
          tradeName: this.props.tradeName?.value ?? null,
          email: this.props.email.value,
          phone: this.props.phone.value,
          address: this.props.address.value,
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
      taxId: this.props.taxId.value,
      email: this.props.email.value,
      phone: this.props.phone.value,
      address: this.props.address.value,
      fiscalProfile: this.props.fiscalProfile?.details ?? null,
      fiscalProfileRevision: this.props.fiscalProfileRevision,
      roles: this.props.roles.values,
      status: this.props.status,
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
    })
  }
}
