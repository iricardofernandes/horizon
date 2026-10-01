import {
  catalogCompositionDefined,
  catalogFamilyDefined,
  catalogItemClassificationChanged,
  catalogItemCreated,
  catalogItemDeactivated,
  catalogPriceChanged,
  catalogVariantAssigned,
} from './catalog'
import {
  crmOpportunityConverted,
  crmOpportunityCreated,
  crmOpportunityLost,
  crmOpportunityOwnerChanged,
  crmOpportunityReopened,
  crmOpportunityRevised,
  crmOpportunityStageChanged,
  crmOpportunityWon,
  crmTaskDue,
} from './crm'
import type { EventDefinition } from './define'
import {
  filesAttachmentAvailable,
  filesAttachmentDeleted,
  filesAttachmentQuarantined,
} from './files'
import {
  financialPayablePosted,
  financialPayableReversed,
  financialReceivablePosted,
  financialReceivableReversed,
  financialSettlementRecorded,
  financialSettlementReversed,
} from './financial'
import {
  fiscalCalculationLocked,
  fiscalConsumerDocumentOutcome,
  fiscalDocumentAuthorized,
  fiscalDocumentCancelled,
  fiscalDocumentHomologationObserved,
  fiscalDocumentProductionOutcome,
  fiscalDocumentRejected,
  fiscalInboundMatched,
  fiscalLinkedDocumentOutcome,
  fiscalServiceDocumentOutcome,
} from './fiscal'
import {
  apiKeyRevoked,
  companyFiscalProfileChanged,
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
  catalogImportFinished,
  financialImportFinished,
  financialPayableApprovalRequested,
  inventoryImportFinished,
  partiesImportFinished,
  salesBillingRunFinished,
} from './jobs'
import {
  ledgerAccountOpened,
  ledgerPeriodClosed,
  ledgerPeriodReopened,
  ledgerTransactionPosted,
  ledgerTransactionReversed,
} from './ledger'
import {
  partyErased,
  partyFiscalProfileChanged,
  partyRegistered,
  partyRegisteredV2,
  partyRoleGranted,
  partyRoleRevoked,
  partyUpdated,
  partyUpdatedV2,
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
  salesContractActivated,
  salesContractAmended,
  salesContractCancelled,
  salesContractPeriodBilled,
  salesContractPeriodCredited,
  salesContractSuspended,
  salesFiscalOriginFrozen,
  salesFiscalOriginRecorded,
  salesInvoicingRequested,
  salesOrderCancelled,
  salesOrderConfirmed,
  salesOrderPlaced,
  salesQuoteAccepted,
  salesQuoteRejected,
  salesQuoteSent,
  salesServiceDelivered,
  salesServiceDeliveryCancelled,
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
export * from './crm'
export * from './define'
export * from './files'
export * from './financial'
export * from './fiscal'
export * from './identity'
export * from './inventory'
export * from './jobs'
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
  companyFiscalProfileChanged,
  catalogItemCreated,
  catalogItemClassificationChanged,
  catalogItemDeactivated,
  catalogPriceChanged,
  catalogFamilyDefined,
  catalogVariantAssigned,
  catalogCompositionDefined,
  salesOrderPlaced,
  inventoryStockReserved,
  inventoryStockReservationRejected,
  salesOrderConfirmed,
  salesOrderCancelled,
  inventoryStockReleased,
  inventoryStockMoved,
  salesInvoicingRequested,
  salesFiscalOriginRecorded,
  salesFiscalOriginFrozen,
  partyRegistered,
  partyUpdated,
  partyRegisteredV2,
  partyUpdatedV2,
  partyRoleGranted,
  partyRoleRevoked,
  partyErased,
  partyFiscalProfileChanged,
  financialReceivablePosted,
  financialReceivableReversed,
  financialSettlementRecorded,
  financialSettlementReversed,
  financialPayablePosted,
  financialPayableReversed,
  fiscalDocumentAuthorized,
  fiscalDocumentRejected,
  fiscalDocumentCancelled,
  fiscalDocumentHomologationObserved,
  fiscalDocumentProductionOutcome,
  fiscalInboundMatched,
  fiscalLinkedDocumentOutcome,
  fiscalConsumerDocumentOutcome,
  fiscalServiceDocumentOutcome,
  fiscalCalculationLocked,
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
  salesServiceDelivered,
  salesServiceDeliveryCancelled,
  salesContractActivated,
  salesContractAmended,
  salesContractSuspended,
  salesContractCancelled,
  salesContractPeriodBilled,
  salesContractPeriodCredited,
  crmOpportunityCreated,
  crmOpportunityRevised,
  crmOpportunityStageChanged,
  crmOpportunityOwnerChanged,
  crmOpportunityWon,
  crmOpportunityLost,
  crmOpportunityReopened,
  crmOpportunityConverted,
  crmTaskDue,
  filesAttachmentAvailable,
  filesAttachmentQuarantined,
  filesAttachmentDeleted,
  partiesImportFinished,
  catalogImportFinished,
  inventoryImportFinished,
  financialImportFinished,
  financialPayableApprovalRequested,
  salesBillingRunFinished,
] as const

/** Look up an event definition by `eventType` and `eventVersion`. */
export function findEvent(type: string, version: number): EventDefinition | undefined {
  return EVENTS.find((event) => event.type === type && event.version === version)
}
