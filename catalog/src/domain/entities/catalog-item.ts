import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { CatalogItemCreatedEvent, CatalogItemDeactivatedEvent } from '../events/catalog-events'
import type { CatalogName, NcmCode, Sku } from '../value-objects/catalog-values'

export type CatalogItemKind = 'product' | 'service'
interface ItemProps {
  tenantId: string
  kind: CatalogItemKind
  sku: Sku
  name: CatalogName
  unitId: string
  ncm: NcmCode | null
  active: boolean
  createdAt: Date
  updatedAt: Date
}
export interface CatalogItemSnapshot {
  readonly id: string
  readonly tenantId: string
  readonly kind: CatalogItemKind
  readonly sku: string
  readonly name: string
  readonly unitId: string
  readonly ncm: string | null
  readonly active: boolean
  readonly createdAt: Date
  readonly updatedAt: Date
}

export class CatalogItem extends AggregateRoot<ItemProps> {
  static create(
    props: Omit<ItemProps, 'active' | 'createdAt' | 'updatedAt'> & {
      active?: boolean
      createdAt?: Date
      updatedAt?: Date
    },
    id?: UniqueEntityID,
  ): CatalogItem {
    const now = props.createdAt ?? new Date()
    return new CatalogItem(
      { ...props, active: props.active ?? true, createdAt: now, updatedAt: props.updatedAt ?? now },
      id,
    )
  }
  static register(
    props: Omit<ItemProps, 'active' | 'createdAt' | 'updatedAt'> & { now: Date },
  ): CatalogItem {
    const item = CatalogItem.create({ ...props, createdAt: props.now, updatedAt: props.now })
    item.addDomainEvent(
      new CatalogItemCreatedEvent(item.id, props.tenantId, props.now, {
        kind: props.kind,
        sku: props.sku.value,
        name: props.name.value,
        unitId: props.unitId,
        ncm: props.ncm?.value ?? null,
      }),
    )
    return item
  }
  deactivate(now: Date): Either<ConflictError, void> {
    if (!this.props.active) return left(new ConflictError('catalog item is already inactive'))
    this.props.active = false
    this.props.updatedAt = now
    this.addDomainEvent(new CatalogItemDeactivatedEvent(this.id, this.props.tenantId, now))
    return right(undefined)
  }
  isActive(): boolean {
    return this.props.active
  }
  belongsTo(tenantId: string): boolean {
    return this.props.tenantId === tenantId
  }
  toSnapshot(): Readonly<CatalogItemSnapshot> {
    return Object.freeze({
      id: this.id.toString(),
      ...this.props,
      sku: this.props.sku.value,
      name: this.props.name.value,
      ncm: this.props.ncm?.value ?? null,
    })
  }
}
