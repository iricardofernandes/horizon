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

export class CatalogItemClassificationChangedEvent extends CatalogEvent {
  readonly eventType = 'catalog.item.classification-changed'
  constructor(
    id: UniqueEntityID,
    tenantId: string,
    occurredAt: Date,
    private readonly classification: {
      revision: number
      effectiveFrom: string
      ncm: string | null
    },
  ) {
    super(id, tenantId, occurredAt)
  }
  payloadOf(): Readonly<Record<string, unknown>> {
    return { itemId: this.aggregateId.toString(), ...this.classification }
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

export class CatalogFamilyDefinedEvent extends CatalogEvent {
  readonly eventType = 'catalog.family.defined'
  constructor(
    id: UniqueEntityID,
    tenantId: string,
    occurredAt: Date,
    private readonly family: { name: string; attributes: readonly string[] },
  ) {
    super(id, tenantId, occurredAt)
  }
  payloadOf(): Readonly<Record<string, unknown>> {
    return { familyId: this.aggregateId.toString(), ...this.family }
  }
}

export class CatalogVariantAssignedEvent extends CatalogEvent {
  readonly eventType = 'catalog.variant.assigned'
  constructor(
    id: UniqueEntityID,
    tenantId: string,
    occurredAt: Date,
    private readonly variant: {
      familyId: string
      values: readonly { attribute: string; value: string }[]
    },
  ) {
    super(id, tenantId, occurredAt)
  }
  payloadOf(): Readonly<Record<string, unknown>> {
    return { itemId: this.aggregateId.toString(), ...this.variant }
  }
}

export class CatalogCompositionDefinedEvent extends CatalogEvent {
  readonly eventType = 'catalog.composition.defined'
  constructor(
    id: UniqueEntityID,
    tenantId: string,
    occurredAt: Date,
    private readonly composition: {
      parentItemId: string
      version: number
      realisation: 'assembled' | 'exploded'
      effectiveFrom: string
      lines: readonly { componentItemId: string; quantity: string }[]
    },
  ) {
    super(id, tenantId, occurredAt)
  }
  payloadOf(): Readonly<Record<string, unknown>> {
    return { compositionId: this.aggregateId.toString(), ...this.composition }
  }
}
