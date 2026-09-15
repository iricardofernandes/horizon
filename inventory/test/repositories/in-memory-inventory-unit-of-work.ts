import type { EventOutcome, InventoryScope, ReceivedEvent } from '@/application/ports/unit-of-work'
import { InventoryUnitOfWork } from '@/application/ports/unit-of-work'
import type { DomainEvent } from '@/core/events/domain-event'
import type { StockBalance } from '@/domain/entities/stock-balance'
import type { StockReservation } from '@/domain/entities/stock-reservation'
import {
  InventoryEventsRepository,
  StockBalancesRepository,
  StockReservationsRepository,
} from '@/domain/repositories/inventory-repositories'

class InMemoryBalances extends StockBalancesRepository {
  constructor(
    private readonly tenantId: string,
    private readonly records: StockBalance[],
  ) {
    super()
  }
  lock(itemId: string, warehouseId: string): Promise<StockBalance | null> {
    return Promise.resolve(
      this.records.find((balance) => {
        const record = balance.toSnapshot()
        return (
          balance.belongsTo(this.tenantId) &&
          record.itemId === itemId &&
          record.warehouseId === warehouseId
        )
      }) ?? null,
    )
  }
  save(balance: StockBalance): Promise<void> {
    if (!balance.belongsTo(this.tenantId)) throw new Error('tenant mismatch')
    return Promise.resolve()
  }
}

class InMemoryReservations extends StockReservationsRepository {
  constructor(
    private readonly tenantId: string,
    private readonly records: StockReservation[],
  ) {
    super()
  }
  findByOrderId(orderId: string): Promise<StockReservation | null> {
    return Promise.resolve(
      this.records.find(
        (reservation) =>
          reservation.belongsTo(this.tenantId) && reservation.orderIdentifier() === orderId,
      ) ?? null,
    )
  }
  create(reservation: StockReservation): Promise<void> {
    if (!reservation.belongsTo(this.tenantId)) throw new Error('tenant mismatch')
    this.records.push(reservation)
    return Promise.resolve()
  }
  save(reservation: StockReservation): Promise<void> {
    if (!reservation.belongsTo(this.tenantId)) throw new Error('tenant mismatch')
    return Promise.resolve()
  }
}

class InMemoryEvents extends InventoryEventsRepository {
  constructor(
    private readonly tenantId: string,
    private readonly records: DomainEvent[],
  ) {
    super()
  }
  append(event: DomainEvent): Promise<void> {
    if (event.tenantId !== this.tenantId) throw new Error('tenant mismatch')
    this.records.push(event)
    return Promise.resolve()
  }
}

export class InMemoryInventoryUnitOfWork extends InventoryUnitOfWork {
  readonly balances: StockBalance[] = []
  readonly reservations: StockReservation[] = []
  readonly events: DomainEvent[] = []
  readonly provisionedTenants = new Set<string>()
  readonly consumedEvents = new Set<string>()

  provisionTenant(tenantId: string): Promise<void> {
    this.provisionedTenants.add(tenantId)
    return Promise.resolve()
  }

  inTenant<T>(tenantId: string, work: (scope: InventoryScope) => Promise<T>): Promise<T> {
    return work({
      tenantId,
      balances: new InMemoryBalances(tenantId, this.balances),
      reservations: new InMemoryReservations(tenantId, this.reservations),
      events: new InMemoryEvents(tenantId, this.events),
    })
  }

  async processEvent<T>(
    tenantId: string,
    event: ReceivedEvent,
    work: (scope: InventoryScope) => Promise<T>,
  ): Promise<EventOutcome<T>> {
    const key = `${tenantId}:${event.sourceModule}:${event.eventId}`
    if (this.consumedEvents.has(key)) return { processed: false }
    const value = await this.inTenant(tenantId, work)
    this.consumedEvents.add(key)
    return { processed: true, value }
  }
}
