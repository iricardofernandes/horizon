import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { Code, Name } from '../value-objects/financial-values'

export const DIMENSION_KINDS = ['department', 'project'] as const
export type DimensionKind = (typeof DIMENSION_KINDS)[number]

interface DimensionProps {
  tenantId: string
  kind: DimensionKind
  code: Code
  name: Name
  active: boolean
  createdAt: Date
  updatedAt: Date
}

export interface DimensionSnapshot {
  readonly id: string
  readonly tenantId: string
  readonly kind: DimensionKind
  readonly code: string
  readonly name: string
  readonly active: boolean
  readonly createdAt: Date
  readonly updatedAt: Date
}

/**
 * Who money is for: a department or a project an amount can be allocated to, by share,
 * alongside the category that says what it is for.
 */
export class AnalyticDimension extends AggregateRoot<DimensionProps> {
  static define(
    props: { tenantId: string; kind: DimensionKind; code: Code; name: Name; now: Date },
    id?: UniqueEntityID,
  ): AnalyticDimension {
    return new AnalyticDimension(
      { ...props, active: true, createdAt: props.now, updatedAt: props.now },
      id,
    )
  }

  static rehydrate(props: DimensionProps, id: UniqueEntityID): AnalyticDimension {
    return new AnalyticDimension(props, id)
  }

  isActive(): boolean {
    return this.props.active
  }

  changeStatus(active: boolean, now: Date): Either<ConflictError, void> {
    if (this.props.active === active)
      return left(
        new ConflictError(`${this.props.kind} is already ${active ? 'active' : 'inactive'}`),
      )
    this.props.active = active
    this.props.updatedAt = now
    return right(undefined)
  }

  toSnapshot(): Readonly<DimensionSnapshot> {
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      kind: this.props.kind,
      code: this.props.code.value,
      name: this.props.name.value,
      active: this.props.active,
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
    })
  }
}
