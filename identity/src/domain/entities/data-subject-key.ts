import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { DataSubjectErasedEvent } from '@/domain/events/data-subject-erased-event'

interface DataSubjectKeyProps {
  readonly tenantId: string
  /** Base64 key material, or `null` once erased. `null` **is** the erasure. */
  material: string | null
  readonly createdAt: Date
  erasedAt?: Date
}

export interface DataSubjectKeySnapshot {
  readonly id: string
  readonly tenantId: string
  readonly material: string | null
  readonly createdAt: Date
  readonly erasedAt: Date | null
}

/**
 * The key whose destruction is erasure (ADR 0026).
 *
 * Erasure destroys the *key*, not the *row*. The ciphertext stays exactly where it was,
 * byte for byte, so the audit hash chain still verifies — nothing it hashed has changed —
 * and the plaintext becomes unrecoverable by anyone, including the operator. What
 * survives is the *shape* of history: that a user existed, that actions occurred, that
 * records changed, with the personal content cryptographically destroyed.
 *
 * It also reaches backups, which a `DELETE` cannot: a backup taken yesterday holds
 * ciphertext whose key no longer exists in any live system, so restoring it resurrects
 * nothing.
 *
 * The subject id **is** this aggregate's id, so there is exactly one key per subject and
 * no lookup table to get out of step.
 */
export class DataSubjectKey extends AggregateRoot<DataSubjectKeyProps> {
  static create(
    props: {
      tenantId: string
      material: string | null
      createdAt?: Date
      erasedAt?: Date
    },
    id: UniqueEntityID,
  ): DataSubjectKey {
    return new DataSubjectKey(
      {
        tenantId: props.tenantId,
        material: props.material,
        createdAt: props.createdAt ?? new Date(),
        ...(props.erasedAt === undefined ? {} : { erasedAt: props.erasedAt }),
      },
      id,
    )
  }

  static issue(props: {
    tenantId: string
    subjectId: string
    material: string
    now: Date
  }): DataSubjectKey {
    return DataSubjectKey.create(
      { tenantId: props.tenantId, material: props.material, createdAt: props.now },
      new UniqueEntityID(props.subjectId),
    )
  }

  isErased(): boolean {
    return this.props.material === null
  }

  /**
   * The key, or `null` when it has been destroyed.
   *
   * Not an accessor in the sense ADR 0031 forbids: it is the aggregate's single purpose,
   * and its `null` return is the answer to "has this subject been erased", which callers
   * must handle. Every read of personal data pays a fetch and a decryption; keys are
   * cached per request, never across requests (ADR 0026).
   */
  material(): string | null {
    return this.props.material
  }

  /** Irreversible, and *provably* so — which is a stronger guarantee than a `DELETE`. */
  destroy(now: Date): Either<ConflictError, void> {
    if (this.props.material === null)
      return left(new ConflictError('this data subject has already been erased'))

    this.props.material = null
    this.props.erasedAt = now
    this.addDomainEvent(new DataSubjectErasedEvent(this.id, this.props.tenantId, now))
    return right(undefined)
  }

  toSnapshot(): Readonly<DataSubjectKeySnapshot> {
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      material: this.props.material,
      createdAt: this.props.createdAt,
      erasedAt: this.props.erasedAt ?? null,
    })
  }
}
