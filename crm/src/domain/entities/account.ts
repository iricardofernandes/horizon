import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import {
  type DocumentType,
  isAccountRole,
  type PartyKind,
  type Segment,
  Tags,
} from '../value-objects/crm-values'

export type AccountStatus = 'active' | 'inactive' | 'erased'

/** What the party registry says about the party behind an account (ADR 0057). */
export interface PartyFacts {
  /** Null only when a replayed v1 update was the first thing CRM heard of the party. */
  readonly kind: PartyKind | null
  readonly legalName: string
  readonly tradeName: string | null
  readonly roles: readonly string[]
  readonly documentType: DocumentType | null
  readonly documentCountry: string | null
  readonly active: boolean
}

/** What CRM itself says about the account: who looks after it and how it is grouped. */
export interface AccountProfile {
  readonly ownerId: string | null
  readonly segment: Segment | null
  readonly tags: Tags
}

interface AccountProps {
  tenantId: string
  ownerId: string | null
  segment: Segment | null
  tags: Tags
  party: PartyFacts
  status: AccountStatus
  createdAt: Date
  updatedAt: Date
}

export interface AccountSnapshot {
  readonly id: string
  readonly tenantId: string
  readonly kind: PartyKind | null
  readonly legalName: string | null
  readonly tradeName: string | null
  readonly roles: readonly string[]
  readonly documentType: DocumentType | null
  readonly documentCountry: string | null
  readonly partyActive: boolean
  readonly ownerId: string | null
  readonly segment: string | null
  readonly tags: readonly string[]
  readonly status: AccountStatus
  readonly createdAt: Date
  readonly updatedAt: Date
}

function statusOf(party: PartyFacts): AccountStatus {
  return party.active && party.roles.some(isAccountRole) ? 'active' : 'inactive'
}

/**
 * A party the business is trying to win or keep: CRM's projection of a party holding
 * `prospect`, `customer` or `partner` (ADR 0057), plus what only CRM knows about it.
 *
 * The id is the party id. The registry owns the name, the document and the roles; CRM
 * owns the owner, the segment and the tags. Once a party has been an account it stays
 * one — inactive when it stops holding a CRM role — because its history still belongs
 * to it.
 */
export class Account extends AggregateRoot<AccountProps> {
  /** A party with no CRM role is not an account yet; the caller ignores it. */
  static project(
    props: { tenantId: string; party: PartyFacts; now: Date },
    partyId: UniqueEntityID,
  ): Account | null {
    if (!props.party.roles.some(isAccountRole)) return null
    return new Account(
      {
        tenantId: props.tenantId,
        party: props.party,
        ownerId: null,
        segment: null,
        tags: Tags.none(),
        status: statusOf(props.party),
        createdAt: props.now,
        updatedAt: props.now,
      },
      partyId,
    )
  }

  static rehydrate(props: AccountProps, id: UniqueEntityID): Account {
    return new Account(props, id)
  }

  /**
   * Replace what the registry says. A fact the update does not carry (the kind or the
   * document of a v1 replay) keeps the value already known. An erased account is never
   * brought back.
   */
  refresh(party: PartyFacts, now: Date): boolean {
    if (this.props.status === 'erased') return false
    this.props.party = {
      ...party,
      kind: party.kind ?? this.props.party.kind,
      documentType: party.documentType ?? this.props.party.documentType,
      documentCountry:
        party.documentType === null ? this.props.party.documentCountry : party.documentCountry,
    }
    this.props.status = statusOf(this.props.party)
    this.props.updatedAt = now
    return true
  }

  /** The registry shredded the party; CRM keeps the row for its history and forgets the names. */
  erase(now: Date): boolean {
    if (this.props.status === 'erased') return false
    this.props.party = { ...this.props.party, legalName: '', tradeName: null }
    this.props.status = 'erased'
    this.props.updatedAt = now
    return true
  }

  /**
   * Change who looks after the account, its segment or its tags. Returns the fields that
   * actually changed, for the audit entry.
   */
  describe(
    profile: Partial<AccountProfile>,
    now: Date,
  ): Either<ConflictError, readonly (keyof AccountProfile)[]> {
    if (this.props.status === 'erased')
      return left(new ConflictError('an erased account cannot be changed'))
    const changed: (keyof AccountProfile)[] = []
    if (profile.ownerId !== undefined && profile.ownerId !== this.props.ownerId) {
      this.props.ownerId = profile.ownerId
      changed.push('ownerId')
    }
    if (profile.segment !== undefined && !sameSegment(profile.segment, this.props.segment)) {
      this.props.segment = profile.segment
      changed.push('segment')
    }
    if (profile.tags !== undefined && !profile.tags.equals(this.props.tags)) {
      this.props.tags = profile.tags
      changed.push('tags')
    }
    if (changed.length) this.props.updatedAt = now
    return right(changed)
  }

  belongsTo(tenantId: string): boolean {
    return this.props.tenantId === tenantId
  }

  isErased(): boolean {
    return this.props.status === 'erased'
  }

  /** New contacts go only to an account the business is still working. */
  acceptsContacts(): boolean {
    return this.props.status === 'active'
  }

  toSnapshot(): Readonly<AccountSnapshot> {
    const erased = this.props.status === 'erased'
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      kind: this.props.party.kind,
      legalName: erased ? null : this.props.party.legalName,
      tradeName: erased ? null : this.props.party.tradeName,
      roles: [...this.props.party.roles],
      documentType: this.props.party.documentType,
      documentCountry: this.props.party.documentCountry,
      partyActive: this.props.party.active,
      ownerId: this.props.ownerId,
      segment: this.props.segment?.value ?? null,
      tags: [...this.props.tags.values],
      status: this.props.status,
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
    })
  }
}

function sameSegment(a: Segment | null, b: Segment | null): boolean {
  return a === null || b === null ? a === b : a.equals(b)
}
