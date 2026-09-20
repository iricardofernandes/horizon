import type { DomainEvent } from '@/core/events/domain-event'
import type { StockAdjustment } from '../entities/stock-adjustment'
import type { StockBalance } from '../entities/stock-balance'
import type { StockCount } from '../entities/stock-count'
import type { StockReservation } from '../entities/stock-reservation'
import type { StockTransfer } from '../entities/stock-transfer'
import type { Warehouse } from '../entities/warehouse'

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

/** Persists domain events to the outbox owned by the surrounding transaction. */
export abstract class InventoryEventsRepository {
  abstract append(event: DomainEvent): Promise<void>
}
