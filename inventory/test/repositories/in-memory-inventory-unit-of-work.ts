import type {
  AuditRecord,
  CommandReceipt,
  EventOutcome,
  InventoryScope,
  ReceivedEvent,
} from '@/application/ports/unit-of-work'
import { AuditTrail, InventoryUnitOfWork } from '@/application/ports/unit-of-work'
import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { DomainEvent } from '@/core/events/domain-event'
import { outstandingByItem } from '@/domain/entities/lot-book'
import type { StockAdjustment } from '@/domain/entities/stock-adjustment'
import type { StockBalance } from '@/domain/entities/stock-balance'
import type { StockCount } from '@/domain/entities/stock-count'
import type { StockReservation } from '@/domain/entities/stock-reservation'
import type { StockTransfer } from '@/domain/entities/stock-transfer'
import { ofLots, ofSerials, type Units } from '@/domain/entities/tracked-units'
import type { Warehouse } from '@/domain/entities/warehouse'
import { InventoryStockMovedEvent } from '@/domain/events/inventory-events'
import {
  AdjustmentPoliciesRepository,
  type AdjustmentPolicy,
  InventoryEventsRepository,
  ItemSerialsRepository,
  ItemTrackingRepository,
  StockAdjustmentsRepository,
  StockBalancesRepository,
  StockCountsRepository,
  type StockLevel,
  StockLevelsRepository,
  StockMovementsRepository,
  StockReservationsRepository,
  StockTransfersRepository,
  type TrackedItem,
  WarehousesRepository,
} from '@/domain/repositories/inventory-repositories'
import type { SerialNumber } from '@/domain/value-objects/tracking'

class InMemoryBalances extends StockBalancesRepository {
  constructor(
    private readonly tenantId: string,
    private readonly records: StockBalance[],
  ) {
    super()
  }
  create(balance: StockBalance): Promise<void> {
    if (!balance.belongsTo(this.tenantId)) throw new Error('tenant mismatch')
    this.records.push(balance)
    return Promise.resolve()
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
  inWarehouse(
    warehouseId: string,
    itemIds: readonly string[] | null,
  ): Promise<readonly StockBalance[]> {
    return Promise.resolve(
      this.records.filter(
        (balance) =>
          balance.belongsTo(this.tenantId) &&
          balance.warehouseId() === warehouseId &&
          (itemIds === null || itemIds.includes(balance.itemId())),
      ),
    )
  }
  save(balance: StockBalance): Promise<void> {
    if (!balance.belongsTo(this.tenantId)) throw new Error('tenant mismatch')
    return Promise.resolve()
  }
}

class InMemoryTransfers extends StockTransfersRepository {
  constructor(
    private readonly tenantId: string,
    private readonly records: StockTransfer[],
  ) {
    super()
  }
  findById(id: string): Promise<StockTransfer | null> {
    return Promise.resolve(
      this.records.find(
        (transfer) => transfer.belongsTo(this.tenantId) && transfer.id.toString() === id,
      ) ?? null,
    )
  }
  create(transfer: StockTransfer): Promise<void> {
    if (!transfer.belongsTo(this.tenantId)) throw new Error('tenant mismatch')
    this.records.push(transfer)
    return Promise.resolve()
  }
}

class InMemoryAdjustments extends StockAdjustmentsRepository {
  constructor(
    private readonly tenantId: string,
    private readonly records: StockAdjustment[],
  ) {
    super()
  }
  findById(id: string): Promise<StockAdjustment | null> {
    return Promise.resolve(
      this.records.find(
        (adjustment) => adjustment.belongsTo(this.tenantId) && adjustment.id.toString() === id,
      ) ?? null,
    )
  }
  create(adjustment: StockAdjustment): Promise<void> {
    if (!adjustment.belongsTo(this.tenantId)) throw new Error('tenant mismatch')
    this.records.push(adjustment)
    return Promise.resolve()
  }
  save(adjustment: StockAdjustment): Promise<void> {
    if (!adjustment.belongsTo(this.tenantId)) throw new Error('tenant mismatch')
    return Promise.resolve()
  }
}

class InMemoryCounts extends StockCountsRepository {
  constructor(
    private readonly tenantId: string,
    private readonly records: StockCount[],
  ) {
    super()
  }
  findById(id: string): Promise<StockCount | null> {
    return Promise.resolve(
      this.records.find((count) => count.belongsTo(this.tenantId) && count.id.toString() === id) ??
        null,
    )
  }
  create(count: StockCount): Promise<void> {
    if (!count.belongsTo(this.tenantId)) throw new Error('tenant mismatch')
    this.records.push(count)
    return Promise.resolve()
  }
  save(count: StockCount): Promise<void> {
    if (!count.belongsTo(this.tenantId)) throw new Error('tenant mismatch')
    return Promise.resolve()
  }
}

class InMemoryTracking extends ItemTrackingRepository {
  constructor(
    private readonly tenantId: string,
    private readonly records: TrackedItem[],
    private readonly balances: StockBalance[],
  ) {
    super()
  }
  find(itemId: string): Promise<TrackedItem | null> {
    return Promise.resolve(
      this.records.find((item) => item.tenantId === this.tenantId && item.itemId === itemId) ??
        null,
    )
  }
  list(): Promise<readonly TrackedItem[]> {
    return Promise.resolve(this.records.filter((item) => item.tenantId === this.tenantId))
  }
  holdsStock(itemId: string): Promise<boolean> {
    return Promise.resolve(
      this.balances.some(
        (balance) =>
          balance.belongsTo(this.tenantId) &&
          balance.itemId() === itemId &&
          !balance.onHand().isZero(),
      ),
    )
  }
  save(item: TrackedItem): Promise<void> {
    if (item.tenantId !== this.tenantId) throw new Error('tenant mismatch')
    const index = this.records.findIndex(
      (existing) => existing.tenantId === item.tenantId && existing.itemId === item.itemId,
    )
    if (index === -1) this.records.push(item)
    else this.records[index] = item
    return Promise.resolve()
  }
}

/**
 * What a return reads back off the shipments an order made.
 *
 * Collected from the movement events the fakes have seen, which is the same place the
 * real one reads it from — the difference being that this one has never been written to
 * disk.
 */
/** Which named units are on some shelf, read off the balances the fakes hold. */
class InMemorySerials extends ItemSerialsRepository {
  constructor(
    private readonly tenantId: string,
    private readonly balances: StockBalance[],
  ) {
    super()
  }
  inStock(itemId: string, serials: readonly string[]): Promise<readonly string[]> {
    const wanted = new Set(serials)
    const held = this.balances
      .filter((balance) => balance.belongsTo(this.tenantId) && balance.itemId() === itemId)
      .flatMap((balance) => balance.serials().map((one) => one.serial.value))
    return Promise.resolve(held.filter((serial) => wanted.has(serial)))
  }
}

class InMemoryMovements extends StockMovementsRepository {
  constructor(private readonly events: DomainEvent[]) {
    super()
  }
  unitsShippedFor(orderId: string): Promise<ReadonlyMap<string, Units>> {
    const movements = this.events
      .filter(
        (event): event is InventoryStockMovedEvent => event instanceof InventoryStockMovedEvent,
      )
      .map((event) => event.movementOf())
      .filter((movement) => movement.origin?.document.id === orderId)
    const outstanding = outstandingByItem(
      movements.flatMap((movement) =>
        movement.units.lots.map((lot) => ({
          itemId: movement.itemId,
          code: lot.code,
          expiresOn: lot.expiresOn,
          quantity: lot.quantity,
          outbound: movement.kind === 'shipment',
        })),
      ),
    )
    const sent = new Map<string, Map<string, SerialNumber>>()
    for (const movement of movements)
      for (const serial of movement.units.serials) {
        const held = sent.get(movement.itemId) ?? new Map<string, SerialNumber>()
        if (movement.kind === 'shipment') held.set(serial.value, serial)
        else held.delete(serial.value)
        sent.set(movement.itemId, held)
      }
    const byItem = new Map<string, Units>()
    for (const [itemId, lots] of outstanding) byItem.set(itemId, ofLots([...lots]))
    for (const [itemId, serials] of sent)
      if (serials.size > 0) byItem.set(itemId, ofSerials([...serials.values()]))
    return Promise.resolve(byItem)
  }
}

class InMemoryLevels extends StockLevelsRepository {
  constructor(
    private readonly tenantId: string,
    private readonly records: StockLevel[],
  ) {
    super()
  }
  save(level: StockLevel): Promise<void> {
    if (level.tenantId !== this.tenantId) throw new Error('tenant mismatch')
    const index = this.records.findIndex(
      (existing) =>
        existing.tenantId === level.tenantId &&
        existing.warehouseId === level.warehouseId &&
        existing.itemId === level.itemId,
    )
    if (index === -1) this.records.push(level)
    else this.records[index] = level
    return Promise.resolve()
  }
}

class InMemoryPolicies extends AdjustmentPoliciesRepository {
  constructor(
    private readonly tenantId: string,
    private readonly records: AdjustmentPolicy[],
  ) {
    super()
  }
  find(currency: string): Promise<AdjustmentPolicy | null> {
    return Promise.resolve(
      this.records.find(
        (policy) => policy.tenantId === this.tenantId && policy.currency === currency,
      ) ?? null,
    )
  }
  list(): Promise<readonly AdjustmentPolicy[]> {
    return Promise.resolve(this.records.filter((policy) => policy.tenantId === this.tenantId))
  }
  save(policy: AdjustmentPolicy): Promise<void> {
    if (policy.tenantId !== this.tenantId) throw new Error('tenant mismatch')
    const index = this.records.findIndex(
      (existing) => existing.tenantId === policy.tenantId && existing.currency === policy.currency,
    )
    if (index === -1) this.records.push(policy)
    else this.records[index] = policy
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

class InMemoryWarehouses extends WarehousesRepository {
  constructor(
    private readonly tenantId: string,
    private readonly records: Warehouse[],
  ) {
    super()
  }
  findById(id: string): Promise<Warehouse | null> {
    return Promise.resolve(
      this.records.find(
        (warehouse) => warehouse.belongsTo(this.tenantId) && warehouse.id.toString() === id,
      ) ?? null,
    )
  }
  findByName(name: string): Promise<Warehouse | null> {
    return Promise.resolve(
      this.records.find((warehouse) => {
        const row = warehouse.toSnapshot()
        return warehouse.belongsTo(this.tenantId) && row.name === name
      }) ?? null,
    )
  }
  create(warehouse: Warehouse): Promise<void> {
    if (!warehouse.belongsTo(this.tenantId)) throw new Error('tenant mismatch')
    this.records.push(warehouse)
    return Promise.resolve()
  }
  save(warehouse: Warehouse): Promise<void> {
    if (!warehouse.belongsTo(this.tenantId)) throw new Error('tenant mismatch')
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
  readonly warehouses: Warehouse[] = []
  readonly reservations: StockReservation[] = []
  readonly transfers: StockTransfer[] = []
  readonly adjustments: StockAdjustment[] = []
  readonly counts: StockCount[] = []
  readonly policies: AdjustmentPolicy[] = []
  readonly levels: StockLevel[] = []
  readonly trackedItems: TrackedItem[] = []
  readonly auditRecords: AuditRecord[] = []
  readonly receipts = new Map<string, { receipt: CommandReceipt; response: unknown }>()
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
      warehouses: new InMemoryWarehouses(tenantId, this.warehouses),
      balances: new InMemoryBalances(tenantId, this.balances),
      tracking: new InMemoryTracking(tenantId, this.trackedItems, this.balances),
      movements: new InMemoryMovements(this.events),
      serials: new InMemorySerials(tenantId, this.balances),
      reservations: new InMemoryReservations(tenantId, this.reservations),
      transfers: new InMemoryTransfers(tenantId, this.transfers),
      adjustments: new InMemoryAdjustments(tenantId, this.adjustments),
      counts: new InMemoryCounts(tenantId, this.counts),
      policies: new InMemoryPolicies(tenantId, this.policies),
      levels: new InMemoryLevels(tenantId, this.levels),
      events: new InMemoryEvents(tenantId, this.events),
      audit: new InMemoryAudit(this.auditRecords),
    })
  }

  async once<E, T>(
    tenantId: string,
    receipt: CommandReceipt,
    work: (scope: InventoryScope) => Promise<Either<E, T>>,
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
    work: (scope: InventoryScope) => Promise<T>,
  ): Promise<EventOutcome<T>> {
    const key = `${tenantId}:${event.sourceModule}:${event.eventId}`
    if (this.consumedEvents.has(key)) return { processed: false }
    const value = await this.inTenant(tenantId, work)
    this.consumedEvents.add(key)
    return { processed: true, value }
  }
}
