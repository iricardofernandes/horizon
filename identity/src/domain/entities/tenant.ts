import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { TenantCreatedEvent } from '@/domain/events/tenant-created-event'
import type { TenantName } from '@/domain/value-objects/tenant-name'
import type { TenantSlug } from '@/domain/value-objects/tenant-slug'
import type { Timezone } from '@/domain/value-objects/timezone'

export const TENANT_STATUSES = ['active', 'suspended'] as const
export type TenantStatus = (typeof TENANT_STATUSES)[number]

interface TenantProps {
  name: TenantName
  slug: TenantSlug
  timezone: Timezone
  status: TenantStatus
  readonly createdAt: Date
  updatedAt: Date
}

/** The frozen struct mappers and presenters read. The only way out (ADR 0031). */
export interface TenantSnapshot {
  readonly id: string
  readonly name: string
  readonly slug: string
  readonly timezone: string
  readonly status: TenantStatus
  readonly createdAt: Date
  readonly updatedAt: Date
}

/**
 * A tenant. The isolation unit every other module scopes its data by.
 *
 * Its id *is* the tenant id, which is what lets `tenants` sit behind the same RLS policy
 * as every other table (`id = current_setting('app.current_tenant')`) with no exception
 * carved out for it: the id is generated first, the tenant context is opened on it, and
 * the insert happens inside that context. Creating a tenant needs no privileged path.
 */
export class Tenant extends AggregateRoot<TenantProps> {
  static create(
    props: {
      name: TenantName
      slug: TenantSlug
      timezone: Timezone
      status?: TenantStatus
      createdAt?: Date
      updatedAt?: Date
    },
    id?: UniqueEntityID,
  ): Tenant {
    const now = props.createdAt ?? new Date()
    return new Tenant(
      {
        name: props.name,
        slug: props.slug,
        timezone: props.timezone,
        status: props.status ?? 'active',
        createdAt: now,
        updatedAt: props.updatedAt ?? now,
      },
      id,
    )
  }

  /** Construction plus the fact of it. Used once, by `CreateTenantUseCase`. */
  static register(props: {
    name: TenantName
    slug: TenantSlug
    timezone: Timezone
    now: Date
  }): Tenant {
    const id = new UniqueEntityID()
    const tenant = Tenant.create(
      { name: props.name, slug: props.slug, timezone: props.timezone, createdAt: props.now },
      id,
    )
    tenant.addDomainEvent(
      new TenantCreatedEvent(id, id.toString(), props.name.value, props.timezone.value, props.now),
    )
    return tenant
  }

  isActive(): boolean {
    return this.props.status === 'active'
  }

  rename(name: TenantName, now: Date): void {
    this.props.name = name
    this.props.updatedAt = now
  }

  moveTo(timezone: Timezone, now: Date): void {
    this.props.timezone = timezone
    this.props.updatedAt = now
  }

  suspend(now: Date): Either<ConflictError, void> {
    if (this.props.status === 'suspended')
      return left(new ConflictError('tenant is already suspended'))
    this.props.status = 'suspended'
    this.props.updatedAt = now
    return right(undefined)
  }

  reinstate(now: Date): Either<ConflictError, void> {
    if (this.props.status === 'active') return left(new ConflictError('tenant is already active'))
    this.props.status = 'active'
    this.props.updatedAt = now
    return right(undefined)
  }

  toSnapshot(): Readonly<TenantSnapshot> {
    return Object.freeze({
      id: this.id.toString(),
      name: this.props.name.value,
      slug: this.props.slug.value,
      timezone: this.props.timezone.value,
      status: this.props.status,
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
    })
  }
}
