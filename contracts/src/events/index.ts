import { catalogItemCreated, catalogItemDeactivated, catalogPriceChanged } from './catalog'
import type { EventDefinition } from './define'
import {
  financialReceivablePosted,
  financialReceivableReversed,
  financialSettlementRecorded,
  financialSettlementReversed,
} from './financial'
import {
  apiKeyRevoked,
  dataSubjectErased,
  sessionReuseDetected,
  tenantCreated,
  userDisabled,
  userRegistered,
} from './identity'
import {
  inventoryStockMoved,
  inventoryStockReleased,
  inventoryStockReservationRejected,
  inventoryStockReserved,
} from './inventory'
import {
  partyErased,
  partyRegistered,
  partyRoleGranted,
  partyRoleRevoked,
  partyUpdated,
} from './parties'
import {
  salesInvoicingRequested,
  salesOrderCancelled,
  salesOrderConfirmed,
  salesOrderPlaced,
} from './sales'

export * from './catalog'
export * from './define'
export * from './financial'
export * from './identity'
export * from './inventory'
export * from './parties'
export * from './sales'

/**
 * Every event Horizon publishes.
 *
 * `docs/events.md` is generated from this, so the catalogue cannot drift from the code,
 * and the compatibility gate walks it to compare each payload against the last published
 * version (ADR 0030).
 */
export const EVENTS: readonly EventDefinition[] = [
  tenantCreated,
  userRegistered,
  userDisabled,
  apiKeyRevoked,
  sessionReuseDetected,
  dataSubjectErased,
  catalogItemCreated,
  catalogItemDeactivated,
  catalogPriceChanged,
  salesOrderPlaced,
  inventoryStockReserved,
  inventoryStockReservationRejected,
  salesOrderConfirmed,
  salesOrderCancelled,
  inventoryStockReleased,
  inventoryStockMoved,
  salesInvoicingRequested,
  partyRegistered,
  partyUpdated,
  partyRoleGranted,
  partyRoleRevoked,
  partyErased,
  financialReceivablePosted,
  financialReceivableReversed,
  financialSettlementRecorded,
  financialSettlementReversed,
] as const

/** Look up an event definition by `eventType` and `eventVersion`. */
export function findEvent(type: string, version: number): EventDefinition | undefined {
  return EVENTS.find((event) => event.type === type && event.version === version)
}
