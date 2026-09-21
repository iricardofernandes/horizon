import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import type { DomainEvent } from '@/core/events/domain-event'
import type { PartyKind, PartyRole } from '../value-objects/party-values'

abstract class PartyEvent implements DomainEvent {
  abstract readonly eventType: string
  readonly eventVersion = 1
  constructor(
    readonly aggregateId: UniqueEntityID,
    readonly tenantId: string,
    readonly occurredAt: Date,
  ) {}
  abstract payloadOf(): Readonly<Record<string, unknown>>
}

/**
 * A party entered the registry.
 *
 * The payload carries the identity a consuming context needs to build its own projection
 * and nothing more: no tax identifier, because a projection that does not need it should
 * not hold a second copy of personal data to erase (ADR 0026, ADR 0040).
 */
export class PartyRegisteredEvent extends PartyEvent {
  readonly eventType = 'parties.party.registered'
  constructor(
    partyId: UniqueEntityID,
    tenantId: string,
    private readonly details: {
      readonly kind: PartyKind
      readonly legalName: string
      readonly tradeName: string | null
      readonly email: string
      readonly phone: string
      readonly address: string
      readonly roles: readonly PartyRole[]
    },
    occurredAt: Date,
  ) {
    super(partyId, tenantId, occurredAt)
  }
  payloadOf() {
    return {
      partyId: this.aggregateId.toString(),
      kind: this.details.kind,
      legalName: this.details.legalName,
      tradeName: this.details.tradeName,
      email: this.details.email,
      phone: this.details.phone,
      address: this.details.address,
      roles: [...this.details.roles],
    }
  }
}

/** The party's identifying details changed; consumers refresh their projection. */
export class PartyUpdatedEvent extends PartyEvent {
  readonly eventType = 'parties.party.updated'
  constructor(
    partyId: UniqueEntityID,
    tenantId: string,
    private readonly details: {
      readonly legalName: string
      readonly tradeName: string | null
      readonly email: string
      readonly phone: string
      readonly address: string
      readonly roles: readonly PartyRole[]
      readonly active: boolean
    },
    occurredAt: Date,
  ) {
    super(partyId, tenantId, occurredAt)
  }
  payloadOf() {
    return {
      partyId: this.aggregateId.toString(),
      legalName: this.details.legalName,
      tradeName: this.details.tradeName,
      email: this.details.email,
      phone: this.details.phone,
      address: this.details.address,
      roles: [...this.details.roles],
      active: this.details.active,
    }
  }
}

/** A role was granted or revoked. Sales cares about `customer`; Purchasing will care about `supplier`. */
export class PartyRoleChangedEvent extends PartyEvent {
  readonly eventType: string
  constructor(
    partyId: UniqueEntityID,
    tenantId: string,
    private readonly change: {
      readonly role: PartyRole
      readonly operation: 'granted' | 'revoked'
      readonly roles: readonly PartyRole[]
    },
    occurredAt: Date,
  ) {
    super(partyId, tenantId, occurredAt)
    this.eventType = `parties.party.role-${change.operation}`
  }
  payloadOf() {
    return {
      partyId: this.aggregateId.toString(),
      role: this.change.role,
      roles: [...this.change.roles],
    }
  }
}

/**
 * The subject's key was destroyed here, and every projection must destroy its own copy.
 *
 * This event carries no personal data by construction: it is the instruction to forget,
 * and a payload with a name in it would defeat the operation it announces.
 */
export class PartyErasedEvent extends PartyEvent {
  readonly eventType = 'parties.party.erased'
  payloadOf() {
    return { partyId: this.aggregateId.toString() }
  }
}

/** A restricted consumer can fetch this exact revision; no profile data enters the bus. */
export class PartyFiscalProfileChangedEvent extends PartyEvent {
  readonly eventType = 'parties.party.fiscal-profile-changed'
  constructor(
    partyId: UniqueEntityID,
    tenantId: string,
    private readonly revision: number,
    private readonly effectiveFrom: string,
    occurredAt: Date,
  ) {
    super(partyId, tenantId, occurredAt)
  }
  payloadOf() {
    return {
      partyId: this.aggregateId.toString(),
      revision: this.revision,
      effectiveFrom: this.effectiveFrom,
    }
  }
}
