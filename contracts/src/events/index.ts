import { catalogItemCreated, catalogItemDeactivated, catalogPriceChanged } from './catalog'
import type { EventDefinition } from './define'
import {
  financialPayablePosted,
  financialPayableReversed,
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
  ledgerAccountOpened,
  ledgerPeriodClosed,
  ledgerPeriodReopened,
  ledgerTransactionPosted,
  ledgerTransactionReversed,
} from './ledger'
import {
  partyErased,
  partyRegistered,
  partyRoleGranted,
  partyRoleRevoked,
  partyUpdated,
} from './parties'
import {
  procurementOrderApproved,
  procurementOrderCancelled,
  procurementOrderClosed,
  procurementOrderPlaced,
  procurementOrderRejected,
  procurementReceiptRecorded,
  procurementReceiptReturned,
  procurementRequisitionApproved,
  procurementRequisitionRejected,
  procurementRequisitionSubmitted,
} from './procurement'
import {
  salesInvoicingRequested,
  salesOrderCancelled,
  salesOrderConfirmed,
  salesOrderPlaced,
  salesQuoteAccepted,
  salesQuoteRejected,
  salesQuoteSent,
  salesShipmentDispatched,
  salesShipmentReturned,
} from './sales'
import {
  treasuryAccountOpened,
  treasuryEntryRecorded,
  treasuryReconciliationConfirmed,
  treasuryReconciliationUndone,
  treasuryStatementImported,
  treasuryTransferCancelled,
  treasuryTransferPosted,
} from './treasury'

export * from './catalog'
export * from './define'
export * from './financial'
export * from './identity'
export * from './inventory'
export * from './ledger'
export * from './parties'
export * from './procurement'
export * from './sales'
export * from './treasury'

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
  financialPayablePosted,
  financialPayableReversed,
  treasuryAccountOpened,
  treasuryEntryRecorded,
  treasuryTransferPosted,
  treasuryTransferCancelled,
  treasuryStatementImported,
  treasuryReconciliationConfirmed,
  treasuryReconciliationUndone,
  ledgerAccountOpened,
  ledgerTransactionPosted,
  ledgerTransactionReversed,
  ledgerPeriodClosed,
  ledgerPeriodReopened,
  procurementRequisitionSubmitted,
  procurementRequisitionApproved,
  procurementRequisitionRejected,
  procurementOrderPlaced,
  procurementOrderApproved,
  procurementOrderRejected,
  procurementOrderCancelled,
  procurementReceiptRecorded,
  procurementReceiptReturned,
  procurementOrderClosed,
  salesQuoteSent,
  salesQuoteAccepted,
  salesQuoteRejected,
  salesShipmentDispatched,
  salesShipmentReturned,
] as const

/** Look up an event definition by `eventType` and `eventVersion`. */
export function findEvent(type: string, version: number): EventDefinition | undefined {
  return EVENTS.find((event) => event.type === type && event.version === version)
}
