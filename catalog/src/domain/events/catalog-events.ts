import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import type { DomainEvent } from '@/core/events/domain-event'

abstract class CatalogEvent implements DomainEvent {
  abstract readonly eventType: string
  readonly eventVersion = 1
  constructor(
    readonly aggregateId: UniqueEntityID,
    readonly tenantId: string,
    readonly occurredAt: Date,
  ) {}
  abstract payloadOf(): Readonly<Record<string, unknown>>
}

export class CatalogItemCreatedEvent extends CatalogEvent {
  readonly eventType = 'catalog.item.created'
  constructor(
    id: UniqueEntityID,
    tenantId: string,
    occurredAt: Date,
    private readonly item: {
      kind: 'product' | 'service'
      sku: string
      name: string
      unitId: string
      ncm: string | null
    },
  ) {
    super(id, tenantId, occurredAt)
  }
  payloadOf(): Readonly<Record<string, unknown>> {
    return { itemId: this.aggregateId.toString(), ...this.item }
  }
}

export class CatalogItemDeactivatedEvent extends CatalogEvent {
  readonly eventType = 'catalog.item.deactivated'
  payloadOf(): Readonly<Record<string, unknown>> {
    return { itemId: this.aggregateId.toString() }
  }
}

export class CatalogPriceChangedEvent extends CatalogEvent {
  readonly eventType = 'catalog.price.changed'
  constructor(
    id: UniqueEntityID,
    tenantId: string,
    occurredAt: Date,
    private readonly price: { itemId: string; amount: string; currency: string },
  ) {
    super(id, tenantId, occurredAt)
  }
  payloadOf(): Readonly<Record<string, unknown>> {
    return { priceListId: this.aggregateId.toString(), ...this.price }
  }
}
