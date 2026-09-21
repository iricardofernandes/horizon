import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import {
  CatalogItemCreatedEvent,
  CatalogItemDeactivatedEvent,
  CatalogVariantAssignedEvent,
} from '../events/catalog-events'
import type { CatalogName, NcmCode, Sku } from '../value-objects/catalog-values'
import { type AttributeAnswer, combinationOf } from './product-family'

export type CatalogItemKind = 'product' | 'service'
interface ItemProps {
  tenantId: string
  kind: CatalogItemKind
  sku: Sku
  name: CatalogName
  unitId: string
  ncm: NcmCode | null
  /**
   * The family this item is one combination of, and its answers.
   *
   * Null for the great majority of items, which are not one of anything. A variant keeps
   * its own SKU, its own stock and its own price — the family only says what makes it
   * different from its siblings.
   */
  variant: { familyId: string; answers: readonly AttributeAnswer[] } | null
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
  readonly variant: {
    familyId: string
    combination: string
    values: readonly { attribute: string; value: string }[]
  } | null
  readonly active: boolean
  readonly createdAt: Date
  readonly updatedAt: Date
}

export class CatalogItem extends AggregateRoot<ItemProps> {
  static create(
    props: Omit<ItemProps, 'active' | 'createdAt' | 'updatedAt' | 'variant'> & {
      variant?: ItemProps['variant']
      active?: boolean
      createdAt?: Date
      updatedAt?: Date
    },
    id?: UniqueEntityID,
  ): CatalogItem {
    const now = props.createdAt ?? new Date()
    return new CatalogItem(
      {
        ...props,
        variant: props.variant ?? null,
        active: props.active ?? true,
        createdAt: now,
        updatedAt: props.updatedAt ?? now,
      },
      id,
    )
  }
  static register(
    props: Omit<ItemProps, 'active' | 'createdAt' | 'updatedAt' | 'variant'> & { now: Date },
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

  kind(): CatalogItemKind {
    return this.props.kind
  }

  variant(): ItemProps['variant'] {
    return this.props.variant
  }

  /** The answers this item gives, in its family's own order and spelling. */
  variantValues(): readonly { attribute: string; value: string }[] {
    return (this.props.variant?.answers ?? []).map((answer) => ({
      attribute: answer.attribute.value,
      value: answer.value.value,
    }))
  }

  /**
   * The item takes its place in a family, as one combination of its attributes.
   *
   * Once taken, the family cannot be changed: the answers were given against *those*
   * axes, and moving the item to a family that varies along different ones would leave it
   * describing itself in a vocabulary nobody uses any more. Restating the same family
   * with the same answers changes nothing and is always allowed, because nothing has
   * moved.
   *
   * That the combination is not already taken by a sibling is a fact about the whole
   * family, which this item cannot see; the use case asks, and a unique index refuses.
   */
  assignTo(
    familyId: string,
    answers: readonly AttributeAnswer[],
    now: Date,
  ): Either<ConflictError, void> {
    if (!this.props.active)
      return left(new ConflictError('an item out of use is not placed in a family'))
    const held = this.props.variant
    if (held && held.familyId !== familyId)
      return left(new ConflictError('an item does not move from one family to another'))
    this.props.variant = { familyId, answers }
    this.props.updatedAt = now
    this.addDomainEvent(
      new CatalogVariantAssignedEvent(this.id, this.props.tenantId, now, {
        familyId,
        values: answers.map((answer) => ({
          attribute: answer.attribute.value,
          value: answer.value.value,
        })),
      }),
    )
    return right(undefined)
  }

  toSnapshot(): Readonly<CatalogItemSnapshot> {
    const variant = this.props.variant
    return Object.freeze({
      id: this.id.toString(),
      ...this.props,
      sku: this.props.sku.value,
      name: this.props.name.value,
      ncm: this.props.ncm?.value ?? null,
      variant: variant
        ? {
            familyId: variant.familyId,
            combination: combinationOf(variant.answers),
            values: variant.answers.map((answer) => ({
              attribute: answer.attribute.value,
              value: answer.value.value,
            })),
          }
        : null,
    })
  }
}
