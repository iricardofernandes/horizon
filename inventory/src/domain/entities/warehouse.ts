import { AggregateRoot } from '@/core/entities/aggregate-root'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import type { WarehouseName } from '../value-objects/inventory-values'

interface WarehouseProps {
  tenantId: string
  name: WarehouseName
  active: boolean
  createdAt: Date
  updatedAt: Date
}

export class Warehouse extends AggregateRoot<WarehouseProps> {
  static create(
    props: { tenantId: string; name: WarehouseName; now?: Date; active?: boolean },
    id?: UniqueEntityID,
  ): Warehouse {
    const now = props.now ?? new Date()
    return new Warehouse(
      {
        tenantId: props.tenantId,
        name: props.name,
        active: props.active ?? true,
        createdAt: now,
        updatedAt: now,
      },
      id,
    )
  }
  belongsTo(tenantId: string): boolean {
    return this.props.tenantId === tenantId
  }
  isActive(): boolean {
    return this.props.active
  }
  toSnapshot(): Readonly<{
    id: string
    tenantId: string
    name: string
    active: boolean
    createdAt: Date
    updatedAt: Date
  }> {
    return Object.freeze({ id: this.id.toString(), ...this.props, name: this.props.name.value })
  }
}
