import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type {
  ContactEmail,
  ContactName,
  ContactPhone,
  JobTitle,
  LawfulBasis,
} from '../value-objects/crm-values'

export type ContactStatus = 'active' | 'inactive' | 'erased'

/** Everything about a contact a person may write; all of it but the basis is personal data. */
export interface ContactDetails {
  readonly name: ContactName
  readonly jobTitle: JobTitle | null
  readonly email: ContactEmail | null
  readonly phone: ContactPhone | null
  readonly lawfulBasis: LawfulBasis
}

interface ContactProps extends ContactDetails {
  tenantId: string
  accountId: string
  status: ContactStatus
  createdAt: Date
  updatedAt: Date
}

export interface ContactSnapshot {
  readonly id: string
  readonly tenantId: string
  readonly accountId: string
  readonly name: string | null
  readonly jobTitle: string | null
  readonly email: string | null
  readonly phone: string | null
  readonly lawfulBasis: LawfulBasis
  readonly status: ContactStatus
  readonly createdAt: Date
  readonly updatedAt: Date
}

type DetailField = keyof ContactDetails

function same(a: { equals(b: unknown): boolean } | null, b: unknown): boolean {
  return a === null ? b === null : a.equals(b)
}

/**
 * A person at an account — the buyer, the finance contact — owned by CRM, not by the
 * party registry: a contact plays no commercial role and needs no document (ADR 0057).
 *
 * Its personal fields are sealed under a key of its own, so erasing it destroys that key
 * and nothing else; the row stays so the account's history can say "a contact, erased".
 */
export class Contact extends AggregateRoot<ContactProps> {
  static create(
    props: ContactDetails & { tenantId: string; accountId: string; now: Date },
    id?: UniqueEntityID,
  ): Contact {
    return new Contact(
      {
        tenantId: props.tenantId,
        accountId: props.accountId,
        name: props.name,
        jobTitle: props.jobTitle,
        email: props.email,
        phone: props.phone,
        lawfulBasis: props.lawfulBasis,
        status: 'active',
        createdAt: props.now,
        updatedAt: props.now,
      },
      id,
    )
  }

  static rehydrate(props: ContactProps, id: UniqueEntityID): Contact {
    return new Contact(props, id)
  }

  get accountId(): string {
    return this.props.accountId
  }

  /** Replace the details; returns the names of the fields that changed, never their values. */
  revise(details: ContactDetails, now: Date): Either<ConflictError, readonly DetailField[]> {
    if (this.props.status === 'erased')
      return left(new ConflictError('an erased contact cannot be edited'))
    const changed = (
      [
        ['name', same(details.name, this.props.name)],
        ['jobTitle', same(details.jobTitle, this.props.jobTitle)],
        ['email', same(details.email, this.props.email)],
        ['phone', same(details.phone, this.props.phone)],
        ['lawfulBasis', details.lawfulBasis === this.props.lawfulBasis],
      ] as const
    )
      .filter(([, unchanged]) => !unchanged)
      .map(([field]) => field)
    Object.assign(this.props, details)
    if (changed.length) this.props.updatedAt = now
    return right(changed)
  }

  deactivate(now: Date): Either<ConflictError, void> {
    if (this.props.status !== 'active') return left(new ConflictError('contact is not active'))
    this.props.status = 'inactive'
    this.props.updatedAt = now
    return right(undefined)
  }

  reactivate(now: Date): Either<ConflictError, void> {
    if (this.props.status !== 'inactive') return left(new ConflictError('contact is not inactive'))
    this.props.status = 'active'
    this.props.updatedAt = now
    return right(undefined)
  }

  /** Crypto-shredding (ADR 0026): the repository destroys the key when it saves this. */
  erase(now: Date): Either<ConflictError, void> {
    if (this.props.status === 'erased') return left(new ConflictError('contact is already erased'))
    this.props.status = 'erased'
    this.props.updatedAt = now
    return right(undefined)
  }

  belongsTo(tenantId: string): boolean {
    return this.props.tenantId === tenantId
  }

  isErased(): boolean {
    return this.props.status === 'erased'
  }

  toSnapshot(): Readonly<ContactSnapshot> {
    const erased = this.props.status === 'erased'
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      accountId: this.props.accountId,
      name: erased ? null : this.props.name.value,
      jobTitle: erased ? null : (this.props.jobTitle?.value ?? null),
      email: erased ? null : (this.props.email?.value ?? null),
      phone: erased ? null : (this.props.phone?.value ?? null),
      lawfulBasis: this.props.lawfulBasis,
      status: this.props.status,
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
    })
  }
}
