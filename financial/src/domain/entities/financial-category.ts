import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { Code, Name } from '../value-objects/financial-values'

export const CATEGORY_NATURES = ['revenue', 'expense'] as const
export type CategoryNature = (typeof CATEGORY_NATURES)[number]

/** Deep enough for `1 Revenue › 1.01 Sales › 1.01.01 Products › 1.01.01.01 Retail`. */
export const MAX_CATEGORY_DEPTH = 4

interface CategoryProps {
  tenantId: string
  code: Code
  name: Name
  nature: CategoryNature
  parentId: string | null
  depth: number
  active: boolean
  createdAt: Date
  updatedAt: Date
}

export interface CategorySnapshot {
  readonly id: string
  readonly tenantId: string
  readonly code: string
  readonly name: string
  readonly nature: CategoryNature
  readonly parentId: string | null
  readonly depth: number
  readonly active: boolean
  readonly createdAt: Date
  readonly updatedAt: Date
}

/**
 * What money is for: a node in the tenant's tree of revenue and expense categories.
 *
 * A child always shares its parent's nature. A tree where "Office rent" can sit under
 * "Revenue" produces a cash flow and a DRE that are wrong in a way no total reveals.
 */
export class FinancialCategory extends AggregateRoot<CategoryProps> {
  static define(
    props: { tenantId: string; code: Code; name: Name; nature: CategoryNature; now: Date },
    parent: FinancialCategory | null,
    id?: UniqueEntityID,
  ): Either<ConflictError, FinancialCategory> {
    if (parent) {
      if (!parent.belongsTo(props.tenantId))
        return left(new ConflictError('parent category belongs to another workspace'))
      if (!parent.props.active) return left(new ConflictError('parent category is inactive'))
      if (parent.props.nature !== props.nature)
        return left(
          new ConflictError(
            `a ${props.nature} category cannot sit under a ${parent.props.nature} category`,
          ),
        )
      if (parent.props.depth >= MAX_CATEGORY_DEPTH)
        return left(new ConflictError(`categories are at most ${MAX_CATEGORY_DEPTH} levels deep`))
    }
    return right(
      new FinancialCategory(
        {
          tenantId: props.tenantId,
          code: props.code,
          name: props.name,
          nature: props.nature,
          parentId: parent ? parent.id.toString() : null,
          depth: parent ? parent.props.depth + 1 : 1,
          active: true,
          createdAt: props.now,
          updatedAt: props.now,
        },
        id,
      ),
    )
  }

  static rehydrate(props: CategoryProps, id: UniqueEntityID): FinancialCategory {
    return new FinancialCategory(props, id)
  }

  belongsTo(tenantId: string): boolean {
    return this.props.tenantId === tenantId
  }

  /** Inactive categories stay on the documents that used them; new documents cannot pick them. */
  changeStatus(active: boolean, now: Date): Either<ConflictError, void> {
    if (this.props.active === active)
      return left(new ConflictError(`category is already ${active ? 'active' : 'inactive'}`))
    this.props.active = active
    this.props.updatedAt = now
    return right(undefined)
  }

  toSnapshot(): Readonly<CategorySnapshot> {
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      code: this.props.code.value,
      name: this.props.name.value,
      nature: this.props.nature,
      parentId: this.props.parentId,
      depth: this.props.depth,
      active: this.props.active,
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
    })
  }
}
