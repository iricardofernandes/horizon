import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { CatalogName, UnitCode } from '../value-objects/catalog-values'

interface UnitProps {
  tenantId: string
  code: UnitCode
  name: CatalogName
  decimalPlaces: number
  active: boolean
  createdAt: Date
  updatedAt: Date
}
export interface UnitSnapshot {
  readonly id: string
  readonly tenantId: string
  readonly code: string
  readonly name: string
  readonly decimalPlaces: number
  readonly active: boolean
  readonly createdAt: Date
  readonly updatedAt: Date
}

export class UnitOfMeasure extends AggregateRoot<UnitProps> {
  static create(
    props: Omit<UnitProps, 'active' | 'createdAt' | 'updatedAt'> & {
      active?: boolean
      createdAt?: Date
      updatedAt?: Date
    },
    id?: UniqueEntityID,
  ): UnitOfMeasure {
    const now = props.createdAt ?? new Date()
    return new UnitOfMeasure(
      { ...props, active: props.active ?? true, createdAt: now, updatedAt: props.updatedAt ?? now },
      id,
    )
  }
  deactivate(now: Date): Either<ConflictError, void> {
    if (!this.props.active) return left(new ConflictError('unit of measure is already inactive'))
    this.props.active = false
    this.props.updatedAt = now
    return right(undefined)
  }
  isActive(): boolean {
    return this.props.active
  }
  belongsTo(tenantId: string): boolean {
    return this.props.tenantId === tenantId
  }
  toSnapshot(): Readonly<UnitSnapshot> {
    return Object.freeze({
      id: this.id.toString(),
      ...this.props,
      code: this.props.code.value,
      name: this.props.name.value,
    })
  }
}
