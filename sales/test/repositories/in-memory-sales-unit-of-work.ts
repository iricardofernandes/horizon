import type {
  AuditRecord,
  CommandReceipt,
  EventOutcome,
  ReceivedEvent,
  SalesScope,
} from '@/application/ports/unit-of-work'
import { AuditTrail, SalesUnitOfWork } from '@/application/ports/unit-of-work'
import { canonicalJson } from '@/core/audit/canonical-json'
import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { DomainEvent } from '@/core/events/domain-event'
import type { Customer } from '@/domain/entities/customer'
import type { Quote } from '@/domain/entities/quote'
import type { SalesOrder } from '@/domain/entities/sales-order'
import type { Shipment } from '@/domain/entities/shipment'
import {
  type CatalogItemProjection,
  CatalogItemsRepository,
  CustomersRepository,
  QuotesRepository,
  SalesEventsRepository,
  SalesOrdersRepository,
  ShipmentsRepository,
} from '@/domain/repositories/sales-repositories'

class InMemoryOrders extends SalesOrdersRepository {
  constructor(
    private readonly tenantId: string,
    private readonly records: SalesOrder[],
  ) {
    super()
  }
  findById(id: string): Promise<SalesOrder | null> {
    return Promise.resolve(
      this.records.find((order) => order.belongsTo(this.tenantId) && order.id.toString() === id) ??
        null,
    )
  }
  create(order: SalesOrder): Promise<void> {
    if (!order.belongsTo(this.tenantId)) throw new Error('tenant mismatch')
    this.records.push(order)
    return Promise.resolve()
  }
  save(order: SalesOrder): Promise<void> {
    if (!order.belongsTo(this.tenantId)) throw new Error('tenant mismatch')
    return Promise.resolve()
  }
}

class InMemoryCatalogItems extends CatalogItemsRepository {
  constructor(
    private readonly tenantId: string,
    private readonly records: CatalogItemProjection[],
    private readonly pending: Map<
      string,
      Partial<Pick<CatalogItemProjection, 'description' | 'unitPrice' | 'active'>>
    >,
  ) {
    super()
  }
  private key(itemId: string): string {
    return `${this.tenantId}:${itemId}`
  }
  findById(id: string): Promise<CatalogItemProjection | null> {
    const complete = this.records.find(
      (item) => item.tenantId === this.tenantId && item.itemId === id,
    )
    if (complete) return Promise.resolve(complete)
    const projected = this.pending.get(this.key(id))
    return Promise.resolve(
      projected?.description && projected.unitPrice
        ? {
            tenantId: this.tenantId,
            itemId: id,
            description: projected.description,
            unitPrice: projected.unitPrice,
            active: projected.active ?? true,
          }
        : null,
    )
  }
  recordItem(item: {
    tenantId: string
    itemId: string
    description: CatalogItemProjection['description']
  }): Promise<void> {
    if (item.tenantId !== this.tenantId) throw new Error('tenant mismatch')
    const key = this.key(item.itemId)
    const existing = this.pending.get(key) ?? {}
    this.pending.set(key, { ...existing, description: item.description, active: true })
    return Promise.resolve()
  }
  recordPrice(itemId: string, unitPrice: CatalogItemProjection['unitPrice']): Promise<void> {
    const key = this.key(itemId)
    const existing = this.pending.get(key) ?? {}
    this.pending.set(key, { ...existing, unitPrice })
    return Promise.resolve()
  }
  deactivate(itemId: string): Promise<void> {
    const key = this.key(itemId)
    const existing = this.pending.get(key) ?? {}
    this.pending.set(key, { ...existing, active: false })
    return Promise.resolve()
  }
}

class InMemoryEvents extends SalesEventsRepository {
  constructor(
    private readonly tenantId: string,
    private readonly records: DomainEvent[],
    private readonly onAppend: (event: DomainEvent) => void,
  ) {
    super()
  }
  append(event: DomainEvent): Promise<void> {
    if (event.tenantId !== this.tenantId) throw new Error('tenant mismatch')
    this.onAppend(event)
    this.records.push(event)
    return Promise.resolve()
  }
}

class InMemoryCustomers extends CustomersRepository {
  constructor(
    private readonly tenantId: string,
    private readonly records: Customer[],
  ) {
    super()
  }
  findById(id: string): Promise<Customer | null> {
    return Promise.resolve(
      this.records.find(
        (customer) => customer.belongsTo(this.tenantId) && customer.id.toString() === id,
      ) ?? null,
    )
  }
  create(customer: Customer): Promise<void> {
    if (!customer.belongsTo(this.tenantId)) throw new Error('tenant mismatch')
    this.records.push(customer)
    return Promise.resolve()
  }
  save(customer: Customer): Promise<void> {
    if (!customer.belongsTo(this.tenantId)) throw new Error('tenant mismatch')
    return Promise.resolve()
  }
  erase(customer: Customer): Promise<void> {
    if (!customer.belongsTo(this.tenantId)) throw new Error('tenant mismatch')
    return Promise.resolve()
  }
}

class InMemoryShipments extends ShipmentsRepository {
  constructor(
    private readonly tenantId: string,
    private readonly records: Shipment[],
  ) {
    super()
  }
  findById(id: string): Promise<Shipment | null> {
    return Promise.resolve(
      this.records.find(
        (shipment) => shipment.belongsTo(this.tenantId) && shipment.id.toString() === id,
      ) ?? null,
    )
  }
  create(shipment: Shipment): Promise<void> {
    if (!shipment.belongsTo(this.tenantId)) throw new Error('tenant mismatch')
    this.records.push(shipment)
    return Promise.resolve()
  }
  save(shipment: Shipment): Promise<void> {
    if (!shipment.belongsTo(this.tenantId)) throw new Error('tenant mismatch')
    return Promise.resolve()
  }
}

class InMemoryAudit extends AuditTrail {
  constructor(private readonly records: AuditRecord[]) {
    super()
  }
  append(record: AuditRecord): Promise<void> {
    this.records.push(record)
    return Promise.resolve()
  }
}

class InMemoryQuotes extends QuotesRepository {
  constructor(
    private readonly tenantId: string,
    private readonly records: Quote[],
    private readonly events: DomainEvent[],
  ) {
    super()
  }
  findById(id: string): Promise<Quote | null> {
    return Promise.resolve(
      this.records.find((quote) => quote.belongsTo(this.tenantId) && quote.id.toString() === id) ??
        null,
    )
  }
  create(quote: Quote): Promise<void> {
    if (!quote.belongsTo(this.tenantId)) throw new Error('tenant mismatch')
    this.records.push(quote)
    this.events.push(...quote.pullDomainEvents())
    return Promise.resolve()
  }
  save(quote: Quote): Promise<void> {
    if (!quote.belongsTo(this.tenantId)) throw new Error('tenant mismatch')
    this.events.push(...quote.pullDomainEvents())
    return Promise.resolve()
  }
}

export class InMemorySalesUnitOfWork extends SalesUnitOfWork {
  readonly orders: SalesOrder[] = []
  readonly catalogItems: CatalogItemProjection[] = []
  readonly projectedCatalogItems = new Map<
    string,
    Partial<Pick<CatalogItemProjection, 'description' | 'unitPrice' | 'active'>>
  >()
  readonly events: DomainEvent[] = []
  readonly customers: Customer[] = []
  readonly quotes: Quote[] = []
  readonly shipments: Shipment[] = []
  readonly auditRecords: AuditRecord[] = []
  readonly receipts = new Map<string, { receipt: CommandReceipt; response: unknown }>()
  readonly provisionedTenants = new Set<string>()
  readonly consumedEvents = new Set<string>()
  readonly fiscalDispatchPolicies = new Map<string, string>()
  readonly fiscalOriginFreezes = new Map<
    string,
    {
      orderId: string
      orderVersion: number
      payloadDigest: string
      establishmentId: string
      warehouseId: string
    }
  >()
  readonly fiscalReleaseObservations: {
    tenantId: string
    eventId?: string
    shipmentId: string
    originDigest: string
    orderVersion: number
    establishmentId: string
    documentId?: string
    documentRevision?: number
    environment: 'simulation' | 'homologation' | 'production'
    outcome: 'authorized' | 'rejected' | 'cancelled'
    observedAt: string
  }[] = []

  provisionTenant(tenantId: string): Promise<void> {
    this.provisionedTenants.add(tenantId)
    return Promise.resolve()
  }

  inTenant<T>(tenantId: string, work: (scope: SalesScope) => Promise<T>): Promise<T> {
    return work({
      tenantId,
      fiscalDispatchGate: {
        policyFor: async (warehouseId) => {
          const establishmentId = this.fiscalDispatchPolicies.get(`${tenantId}:${warehouseId}`)
          return establishmentId ? { establishmentId } : null
        },
        recordOutcome: async (input) => {
          const shipment = this.shipments.find(
            (item) => item.belongsTo(tenantId) && item.id.toString() === input.shipmentId,
          )
          const origin = this.fiscalOriginFreezes.get(`${tenantId}:${input.shipmentId}`)
          const establishmentId = shipment
            ? this.fiscalDispatchPolicies.get(`${tenantId}:${shipment.warehouseId}`)
            : undefined
          if (
            shipment?.status !== 'packed' ||
            !origin ||
            origin.orderId !== shipment.orderId ||
            origin.warehouseId !== shipment.warehouseId ||
            origin.payloadDigest !== input.originDigest ||
            origin.orderVersion !== input.orderVersion ||
            origin.establishmentId !== input.establishmentId ||
            establishmentId !== input.establishmentId ||
            input.environment !== 'production' ||
            input.documentRevision < 1
          )
            throw new Error('Production fiscal outcome does not match a packed frozen origin')
          this.fiscalReleaseObservations.push({
            tenantId,
            ...input,
            observedAt: input.observedAt.toISOString(),
          })
        },
        canDispatch: async (input) => {
          const establishmentId = this.fiscalDispatchPolicies.get(
            `${tenantId}:${input.warehouseId}`,
          )
          if (!establishmentId) return { allowed: true, gated: false }
          const origin = this.fiscalOriginFreezes.get(`${tenantId}:${input.shipmentId}`)
          if (
            !origin ||
            origin.orderId !== input.orderId ||
            origin.orderVersion !== input.orderVersion ||
            origin.establishmentId !== establishmentId ||
            origin.warehouseId !== input.warehouseId
          )
            return { allowed: false, gated: true }
          const latest = this.fiscalReleaseObservations
            .filter((event) => event.tenantId === tenantId && event.shipmentId === input.shipmentId)
            .sort(
              (first, second) =>
                (second.documentRevision ?? 1) - (first.documentRevision ?? 1) ||
                second.observedAt.localeCompare(first.observedAt),
            )[0]
          const blocking =
            latest?.outcome === 'authorized' &&
            this.fiscalReleaseObservations.some(
              (event) =>
                event.tenantId === tenantId &&
                event.shipmentId === input.shipmentId &&
                (event.documentRevision ?? 1) >= (latest.documentRevision ?? 1) &&
                (event.outcome === 'rejected' || event.outcome === 'cancelled'),
            )
          return {
            allowed:
              latest?.environment === 'production' &&
              latest.outcome === 'authorized' &&
              !blocking &&
              latest.originDigest === origin.payloadDigest &&
              latest.orderVersion === origin.orderVersion &&
              latest.establishmentId === establishmentId,
            gated: true,
          }
        },
      },
      orders: new InMemoryOrders(tenantId, this.orders),
      catalogItems: new InMemoryCatalogItems(
        tenantId,
        this.catalogItems,
        this.projectedCatalogItems,
      ),
      events: new InMemoryEvents(tenantId, this.events, (event) => {
        if (event.eventType !== 'sales.fiscal-origin.recorded' || event.eventVersion !== 2) return
        const origin = salesFiscalOriginFrozen.payload.parse(event.payloadOf())
        const establishmentId = this.fiscalDispatchPolicies.get(`${tenantId}:${origin.warehouseId}`)
        if (establishmentId !== origin.establishmentId)
          throw new Error('Pre-dispatch fiscal origin does not match the Sales policy')
        const key = `${tenantId}:${origin.originId}`
        const payloadDigest = createHash('sha256').update(canonicalJson(origin)).digest('hex')
        const existing = this.fiscalOriginFreezes.get(key)
        if (existing && existing.payloadDigest !== payloadDigest)
          throw new Error('Conflicting pre-dispatch fiscal origin')
        this.fiscalOriginFreezes.set(key, {
          orderId: origin.orderId,
          orderVersion: origin.orderVersion,
          payloadDigest,
          establishmentId: origin.establishmentId,
          warehouseId: origin.warehouseId,
        })
      }),
      customers: new InMemoryCustomers(tenantId, this.customers),
      quotes: new InMemoryQuotes(tenantId, this.quotes, this.events),
      shipments: new InMemoryShipments(tenantId, this.shipments),
      audit: new InMemoryAudit(this.auditRecords),
    })
  }

  async once<E, T>(
    tenantId: string,
    receipt: CommandReceipt,
    work: (scope: SalesScope) => Promise<Either<E, T>>,
  ): Promise<Either<E | ConflictError, T>> {
    const key = `${tenantId}:${receipt.idempotencyKey}`
    const previous = this.receipts.get(key)
    if (previous) {
      if (
        previous.receipt.command !== receipt.command ||
        previous.receipt.fingerprint !== receipt.fingerprint
      )
        return left(
          new ConflictError('this Idempotency-Key was already used for a different request'),
        )
      return right(previous.response as T)
    }
    const outcome = await this.inTenant(tenantId, work)
    // A refused command leaves no receipt, exactly as its transaction leaves no rows.
    if (outcome.isRight()) this.receipts.set(key, { receipt, response: outcome.value })
    return outcome
  }

  async processEvent<T>(
    tenantId: string,
    event: ReceivedEvent,
    work: (scope: SalesScope) => Promise<T>,
  ): Promise<EventOutcome<T>> {
    const key = `${tenantId}:${event.sourceModule}:${event.eventId}`
    if (this.consumedEvents.has(key)) return { processed: false }
    const value = await this.inTenant(tenantId, work)
    this.consumedEvents.add(key)
    return { processed: true, value }
  }
}

import { createHash } from 'node:crypto'
import { salesFiscalOriginFrozen } from '@horizon/contracts'
