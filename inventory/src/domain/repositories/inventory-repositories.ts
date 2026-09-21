import type { DomainEvent } from '@/core/events/domain-event'
import type { StockAdjustment } from '../entities/stock-adjustment'
import type { StockBalance } from '../entities/stock-balance'
import type { StockCount } from '../entities/stock-count'
import type { StockReservation } from '../entities/stock-reservation'
import type { StockTransfer } from '../entities/stock-transfer'
import type { Units } from '../entities/tracked-units'
import type { Warehouse } from '../entities/warehouse'
import type { ItemTracking } from '../value-objects/tracking'

export abstract class WarehousesRepository {
  abstract findById(id: string): Promise<Warehouse | null>
  abstract findByName(name: string): Promise<Warehouse | null>
  abstract create(warehouse: Warehouse): Promise<void>
  abstract save(warehouse: Warehouse): Promise<void>
}

export abstract class StockBalancesRepository {
  /** Locks this balance until the surrounding tenant transaction commits. */
  abstract lock(itemId: string, warehouseId: string): Promise<StockBalance | null>
  /**
   * What a warehouse holds, unlocked, for a count sheet to freeze.
   *
   * Deliberately not locked: a count takes hours and the warehouse keeps working through
   * it. The sheet records what the system said when it was opened, and closing it posts
   * the difference against whatever the balance has become since.
   */
  abstract inWarehouse(
    warehouseId: string,
    itemIds: readonly string[] | null,
  ): Promise<readonly StockBalance[]>
  abstract create(balance: StockBalance): Promise<void>
  abstract save(balance: StockBalance): Promise<void>
}

export abstract class StockTransfersRepository {
  abstract findById(id: string): Promise<StockTransfer | null>
  abstract create(transfer: StockTransfer): Promise<void>
}

export abstract class StockAdjustmentsRepository {
  abstract findById(id: string): Promise<StockAdjustment | null>
  abstract create(adjustment: StockAdjustment): Promise<void>
  abstract save(adjustment: StockAdjustment): Promise<void>
}

export abstract class StockCountsRepository {
  abstract findById(id: string): Promise<StockCount | null>
  abstract create(count: StockCount): Promise<void>
  abstract save(count: StockCount): Promise<void>
}

/**
 * The value at or above which an adjustment needs a second person.
 *
 * There is no row meaning "no allowance": a workspace that has not set one has every
 * adjustment approved by somebody else, which is the safe reading of silence and stops
 * the control being turned off by deleting a record.
 */
export interface AdjustmentPolicy {
  readonly tenantId: string
  readonly currency: string
  readonly threshold: bigint
  readonly updatedBy: string
  readonly updatedAt: Date
}

export abstract class AdjustmentPoliciesRepository {
  abstract find(currency: string): Promise<AdjustmentPolicy | null>
  abstract list(): Promise<readonly AdjustmentPolicy[]>
  abstract save(policy: AdjustmentPolicy): Promise<void>
}

/**
 * Whether the warehouse has to know which of a thing it is holding.
 *
 * Inventory's own decision rather than the catalogue's: it governs how goods must be
 * received and picked, which is a fact about the shelf and the people standing at it.
 * An item with no row is counted, not identified.
 */
export interface TrackedItem {
  readonly tenantId: string
  readonly itemId: string
  readonly tracking: ItemTracking
  readonly updatedBy: string
  readonly updatedAt: Date
}

export abstract class ItemTrackingRepository {
  abstract find(itemId: string): Promise<TrackedItem | null>
  abstract list(): Promise<readonly TrackedItem[]>
  /**
   * Whether this item is on any shelf anywhere in the workspace.
   *
   * The decision to identify goods cannot be taken about goods already on a shelf —
   * nobody knows which ones those are — and it cannot be untaken either, because that
   * throws away an answer somebody is relying on. So it may only be changed while there
   * is nothing to be wrong about.
   */
  abstract holdsStock(itemId: string): Promise<boolean>
  abstract save(item: TrackedItem): Promise<void>
}

/**
 * How little of an item a warehouse should get down to, and how much is too much.
 *
 * Unlike the adjustment allowance, this refuses nothing. It is read by a report and by
 * nobody else, which is why a workspace turns it off by setting a minimum of zero rather
 * than by deleting the row: what it wants ignored is worth knowing too.
 */
export interface StockLevel {
  readonly tenantId: string
  readonly warehouseId: string
  readonly itemId: string
  readonly minimum: bigint
  readonly maximum: bigint | null
  readonly updatedBy: string
  readonly updatedAt: Date
}

export abstract class StockLevelsRepository {
  abstract save(level: StockLevel): Promise<void>
}

export abstract class StockReservationsRepository {
  abstract findByOrderId(orderId: string): Promise<StockReservation | null>
  abstract create(reservation: StockReservation): Promise<void>
  abstract save(reservation: StockReservation): Promise<void>
}

/**
 * What the movement ledger can be asked while a command is still running.
 *
 * Only one question so far, and it is the one a customer return has to ask: goods coming
 * home are the same goods, so which lots they went out in has to be read back off the
 * shipments rather than guessed at.
 */
export abstract class StockMovementsRepository {
  /** What this order has sent and not yet had back, by item: lots, or units by name. */
  abstract unitsShippedFor(orderId: string): Promise<ReadonlyMap<string, Units>>
}

/**
 * What every shelf at once knows about a named unit.
 *
 * A balance can only see its own shelf, so the one thing it cannot check is the thing
 * that matters most about a serial: that no other shelf is holding it. Goods arriving
 * from outside the workspace ask this before they claim a name.
 */
export abstract class ItemSerialsRepository {
  /** Of these names, the ones some shelf is already holding. */
  abstract inStock(itemId: string, serials: readonly string[]): Promise<readonly string[]>
}

/** Persists domain events to the outbox owned by the surrounding transaction. */
export abstract class InventoryEventsRepository {
  abstract append(event: DomainEvent): Promise<void>
}
