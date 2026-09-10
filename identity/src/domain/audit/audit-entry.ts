import { Entity } from '@/core/entities/entity'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { chainHash, GENESIS_HASH, type HashedAuditPayload } from './chain'

export const ACTOR_TYPES = ['user', 'api-key', 'system'] as const
export type ActorType = (typeof ACTOR_TYPES)[number]

export interface Actor {
  readonly type: ActorType
  /** `null` for `system` — a scheduled job has no principal to name. */
  readonly id: string | null
}

interface AuditEntryProps extends HashedAuditPayload {
  readonly previousHash: string
  readonly hash: string
}

export interface AuditEntrySnapshot {
  readonly id: string
  readonly sequence: number
  readonly tenantId: string
  readonly actorType: string
  readonly actorId: string | null
  readonly subjectType: string
  readonly subjectId: string
  readonly action: string
  readonly occurredAt: Date
  readonly requestId: string | null
  readonly traceId: string | null
  readonly sourceIp: string | null
  readonly before: Record<string, unknown> | null
  readonly after: Record<string, unknown> | null
  readonly redacted: readonly string[]
  readonly previousHash: string
  readonly hash: string
}

/**
 * One link in a tenant's chain. Immutable by construction — there is no method that
 * changes anything, because the application literally cannot correct an audit entry
 * (ADR 0025). A correction is a new entry referencing the earlier one.
 *
 * Append-only is enforced three times over: here, by `REVOKE UPDATE, DELETE` on the
 * table from the application role, and by a trigger that raises on either — so that if
 * the privileges are ever restored by mistake, the prohibition still holds.
 */
export class AuditEntry extends Entity<AuditEntryProps> {
  /** Recompute the link and rebuild it — used by the verifier and by the mapper. */
  static rehydrate(props: AuditEntryProps, id: UniqueEntityID): AuditEntry {
    return new AuditEntry(props, id)
  }

  /** Append to a chain. The hash is derived, never supplied. */
  static append(props: {
    payload: HashedAuditPayload
    previousHash?: string
    id?: UniqueEntityID
  }): AuditEntry {
    const previousHash = props.previousHash ?? GENESIS_HASH
    return new AuditEntry(
      { ...props.payload, previousHash, hash: chainHash(previousHash, props.payload) },
      props.id,
    )
  }

  /** Does the stored hash still match what the stored content hashes to? */
  verifiesAgainst(previousHash: string): boolean {
    if (this.props.previousHash !== previousHash) return false
    return this.props.hash === chainHash(previousHash, this.hashedPayload())
  }

  /**
   * Exactly the fields that were hashed, and no others.
   *
   * Spreading `this.props` here would fold `previousHash` and `hash` into the digest
   * input, so a rehydrated entry would never verify against the entry that produced it.
   * Naming the members is what keeps append and verify computing the same thing.
   */
  private hashedPayload(): HashedAuditPayload {
    return {
      sequence: this.props.sequence,
      tenantId: this.props.tenantId,
      actorType: this.props.actorType,
      actorId: this.props.actorId,
      subjectType: this.props.subjectType,
      subjectId: this.props.subjectId,
      action: this.props.action,
      occurredAt: this.props.occurredAt,
      requestId: this.props.requestId,
      traceId: this.props.traceId,
      sourceIp: this.props.sourceIp,
      before: this.props.before,
      after: this.props.after,
      redacted: this.props.redacted,
    }
  }

  hashValue(): string {
    return this.props.hash
  }

  sequenceNumber(): number {
    return this.props.sequence
  }

  toSnapshot(): Readonly<AuditEntrySnapshot> {
    return Object.freeze({
      id: this.id.toString(),
      sequence: this.props.sequence,
      tenantId: this.props.tenantId,
      actorType: this.props.actorType,
      actorId: this.props.actorId,
      subjectType: this.props.subjectType,
      subjectId: this.props.subjectId,
      action: this.props.action,
      occurredAt: this.props.occurredAt,
      requestId: this.props.requestId,
      traceId: this.props.traceId,
      sourceIp: this.props.sourceIp,
      before: this.props.before,
      after: this.props.after,
      redacted: this.props.redacted,
      previousHash: this.props.previousHash,
      hash: this.props.hash,
    })
  }
}
