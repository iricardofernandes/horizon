import { z } from 'zod'

import { instantSchema, moneySchema, quantitySchema, uuidSchema } from './common'
import { eventEnvelopeSchema } from './envelope'
import { EVENTS } from './events'
import {
  attachmentLinkSchema,
  attachmentRequestSchema,
  attachmentSchema,
  auditChainSchema,
  auditEntrySchema,
  auditPageSchema,
  auditQuerySchema,
  consistencyCheckSchema,
  consistencyDifferenceSchema,
  consistencyRunSchema,
  delegationSchema,
  fiscalArtifactKindSchema,
  fiscalArtifactKindV2Schema,
  fiscalArtifactListV2Schema,
  fiscalArtifactMetadataSchema,
  fiscalArtifactMetadataV2Schema,
  fiscalCalculationInputSchema,
  fiscalCalculationOutcomeSchema,
  fiscalCancellationRequestSchema,
  fiscalCapabilityListSchema,
  fiscalCapabilityListV2Schema,
  fiscalCapabilitySchema,
  fiscalCapabilityV2Schema,
  fiscalCommandAcceptedSchema,
  fiscalConsumerProblemCodeSchema,
  fiscalCorrectionLetterListSchema,
  fiscalCorrectionLetterRequestSchema,
  fiscalCorrectionLetterSchema,
  fiscalCorrectionLetterStatusSchema,
  fiscalCorrectionRequestSchema,
  fiscalDocumentCreateRequestSchema,
  fiscalDocumentCreateRequestV2Schema,
  fiscalDocumentKindCatalogueSchema,
  fiscalDocumentKindCatalogueV2Schema,
  fiscalDocumentKindEntrySchema,
  fiscalDocumentKindEntryV2Schema,
  fiscalDocumentKindSchema,
  fiscalDocumentLinksSchema,
  fiscalDocumentListSchema,
  fiscalDocumentModelSchema,
  fiscalDocumentSchema,
  fiscalDocumentStatusSchema,
  fiscalDocumentSummarySchema,
  fiscalDocumentTimelineSchema,
  fiscalDocumentTransitionSchema,
  fiscalDocumentV2Schema,
  fiscalDocumentV3Schema,
  fiscalInboundComparisonSchema,
  fiscalInboundConflictDismissalRequestSchema,
  fiscalInboundDifferenceSchema,
  fiscalInboundImportSchema,
  fiscalInboundImportStatusSchema,
  fiscalInboundImportSummarySchema,
  fiscalInboundReconciliationRequestSchema,
  fiscalInboundReconciliationSchema,
  fiscalInboundVerificationSchema,
  fiscalLifecycleProblemCodeSchema,
  fiscalLinkedKindSchema,
  fiscalLinkedOriginRequestSchema,
  fiscalLinkedOriginSchema,
  fiscalLinkedProblemCodeSchema,
  fiscalManualOriginRequestSchema,
  fiscalManualOriginSchema,
  fiscalNfseMunicipalityResolutionSchema,
  fiscalNfseRegistryEntrySchema,
  fiscalNfseRegistryReviewRequestSchema,
  fiscalNfseRegistryVersionRequestSchema,
  fiscalNfseRegistryVersionSchema,
  fiscalReadyDocumentSchema,
  fiscalReadyDocumentV2Schema,
  fiscalServiceCancellationRequestSchema,
  fiscalServiceDocumentCreateRequestSchema,
  fiscalServiceDocumentSchema,
  fiscalServiceIntakeListSchema,
  fiscalServiceIntakeSchema,
  fiscalServiceIntakeStatusSchema,
  fiscalServiceIssuancePolicyRequestSchema,
  fiscalServiceIssuancePolicySchema,
  fiscalServiceOriginRequestSchema,
  fiscalServiceOriginSchema,
  fiscalServiceProblemCodeSchema,
  fiscalServiceProfileListSchema,
  fiscalServiceProfileRequestSchema,
  fiscalServiceProfileSchema,
  fiscalServiceSourceKeySchema,
  fiscalServiceSubstitutionRequestSchema,
  fiscalSupportOverviewSchema,
  grantDelegationSchema,
  importFieldSchema,
  importJobSchema,
  importKindSchema,
  importMappingSchema,
  importPreviewSchema,
  importProgressSchema,
  importRowErrorSchema,
  importUploadSchema,
  journalSealSchema,
  paginationQuerySchema,
  problemDetailsSchema,
  segregationOfDutiesProblemSchema,
  validationProblemSchema,
} from './http'
import { pageInfoSchema } from './http/pagination'
import { permissionIdSchema, roleAssignmentSchema } from './roles'

/**
 * The machine-readable catalogue of everything this package publishes.
 *
 * Two things read it, and that is the reason it exists:
 *
 *   - `scripts/snapshot.mjs` converts each entry to JSON Schema and writes
 *     `published-schemas.json` at publish time;
 *   - `scripts/check-contract-compat.mjs` diffs the current schemas against that
 *     snapshot and fails a breaking change that is not accompanied by a major bump.
 *
 * A schema that is exported but absent from this registry is unversioned and ungated —
 * so `src/registry.spec.ts` asserts that every exported schema appears here.
 */

export type SchemaKind = 'event' | 'http' | 'primitive' | 'authorization'

export interface RegistryEntry {
  readonly id: string
  readonly kind: SchemaKind
  readonly description: string
  readonly schema: z.ZodType
}

const staticEntries: readonly RegistryEntry[] = [
  {
    id: 'envelope',
    kind: 'event',
    description: 'The envelope every published event is wrapped in.',
    schema: eventEnvelopeSchema,
  },
  {
    id: 'primitive:uuid',
    kind: 'primitive',
    description: 'A public identifier. UUIDv7 in practice; the shape is not version-pinned.',
    schema: uuidSchema,
  },
  {
    id: 'primitive:instant',
    kind: 'primitive',
    description: 'A UTC instant, ISO 8601 with offset.',
    schema: instantSchema,
  },
  {
    id: 'primitive:money',
    kind: 'primitive',
    description: 'Integer minor units as a string, plus an explicit ISO 4217 currency.',
    schema: moneySchema,
  },
  {
    id: 'primitive:quantity',
    kind: 'primitive',
    description: 'A non-negative decimal quantity, as a string.',
    schema: quantitySchema,
  },
  {
    id: 'http:fiscal-calculation-input-v1',
    kind: 'http',
    description: 'Complete, versioned facts used to preview or persist a Fiscal calculation.',
    schema: fiscalCalculationInputSchema,
  },
  {
    id: 'http:fiscal-calculation-outcome-v1',
    kind: 'http',
    description: 'Supported Fiscal calculation or a typed unsupported outcome.',
    schema: fiscalCalculationOutcomeSchema,
  },
  {
    id: 'http:fiscal-capability-v1',
    kind: 'http',
    description: 'One exact enabled Fiscal capability and its evidence digests.',
    schema: fiscalCapabilitySchema,
  },
  {
    id: 'http:fiscal-capability-list-v1',
    kind: 'http',
    description: 'Enabled Fiscal capabilities with unsupported as the default.',
    schema: fiscalCapabilityListSchema,
  },
  {
    id: 'http:fiscal-capability-v2',
    kind: 'http',
    description: 'One enabled model-55 simulation or homologation capability without fiscal value.',
    schema: fiscalCapabilityV2Schema,
  },
  {
    id: 'http:fiscal-capability-list-v2',
    kind: 'http',
    description: 'Environment-aware enabled Fiscal capabilities with unsupported as the default.',
    schema: fiscalCapabilityListV2Schema,
  },
  {
    id: 'http:fiscal-manual-origin-request-v1',
    kind: 'http',
    description: 'Tenant-owned revisions used to create an audited manual simulation origin.',
    schema: fiscalManualOriginRequestSchema,
  },
  {
    id: 'http:fiscal-manual-origin-v1',
    kind: 'http',
    description: 'Identity and digest of a frozen manual simulation origin.',
    schema: fiscalManualOriginSchema,
  },
  {
    id: 'http:fiscal-document-create-request-v1',
    kind: 'http',
    description: 'Create a model-55 simulation draft from a frozen Sales or manual origin.',
    schema: fiscalDocumentCreateRequestSchema,
  },
  {
    id: 'http:fiscal-document-v1',
    kind: 'http',
    description: 'Tenant-scoped NF-e simulation document read model.',
    schema: fiscalDocumentSchema,
  },
  {
    id: 'http:fiscal-document-v2',
    kind: 'http',
    description: 'Environment-aware Fiscal document with explicit absence of fiscal value.',
    schema: fiscalDocumentV2Schema,
  },
  {
    id: 'http:fiscal-ready-document-v1',
    kind: 'http',
    description: 'A document made ready with frozen calculation and reconciliation digests.',
    schema: fiscalReadyDocumentSchema,
  },
  {
    id: 'http:fiscal-command-accepted-v1',
    kind: 'http',
    description: 'A durable asynchronous issuance or cancellation command.',
    schema: fiscalCommandAcceptedSchema,
  },
  {
    id: 'http:fiscal-cancellation-request-v1',
    kind: 'http',
    description: 'Reviewed reason for a model-55 simulation cancellation.',
    schema: fiscalCancellationRequestSchema,
  },
  {
    id: 'http:fiscal-correction-request-v1',
    kind: 'http',
    description: 'Create a corrected successor for an immutable rejected document.',
    schema: fiscalCorrectionRequestSchema,
  },
  {
    id: 'http:fiscal-document-status-v1',
    kind: 'http',
    description: 'Public state vocabulary for the NF-e simulation lifecycle.',
    schema: fiscalDocumentStatusSchema,
  },
  {
    id: 'http:fiscal-document-transition-v1',
    kind: 'http',
    description: 'One immutable transition in a Fiscal document timeline.',
    schema: fiscalDocumentTransitionSchema,
  },
  {
    id: 'http:fiscal-document-timeline-v1',
    kind: 'http',
    description: 'Ordered immutable transition history for one Fiscal document.',
    schema: fiscalDocumentTimelineSchema,
  },
  {
    id: 'http:fiscal-artifact-kind-v1',
    kind: 'http',
    description: 'Purpose of one retained NF-e simulation artifact.',
    schema: fiscalArtifactKindSchema,
  },
  {
    id: 'http:fiscal-artifact-metadata-v1',
    kind: 'http',
    description: 'Digest-verified metadata for a retained NF-e simulation artifact.',
    schema: fiscalArtifactMetadataSchema,
  },
  {
    id: 'http:fiscal-artifact-kind-v2',
    kind: 'http',
    description: 'Simulation or homologation artifact purpose.',
    schema: fiscalArtifactKindV2Schema,
  },
  {
    id: 'http:fiscal-artifact-metadata-v2',
    kind: 'http',
    description: 'Environment-aware retained NF-e artifact without fiscal value.',
    schema: fiscalArtifactMetadataV2Schema,
  },
  {
    id: 'http:fiscal-artifact-list-v2',
    kind: 'http',
    description: 'Tenant-scoped environment-aware retained artifact list.',
    schema: fiscalArtifactListV2Schema,
  },
  {
    id: 'http:fiscal-lifecycle-problem-code-v1',
    kind: 'http',
    description: 'Stable problem codes returned by NF-e simulation lifecycle commands.',
    schema: fiscalLifecycleProblemCodeSchema,
  },
  {
    id: 'http:fiscal-inbound-import-status-v1',
    kind: 'http',
    description: 'Open, blocked by a conflicting duplicate, or reconciled supplier NF-e import.',
    schema: fiscalInboundImportStatusSchema,
  },
  {
    id: 'http:fiscal-inbound-difference-v1',
    kind: 'http',
    description: 'A difference between a supplier NF-e line and what was received.',
    schema: fiscalInboundDifferenceSchema,
  },
  {
    id: 'http:fiscal-inbound-verification-v1',
    kind: 'http',
    description: 'Signature, protocol and authority-status evidence of an imported supplier NF-e.',
    schema: fiscalInboundVerificationSchema,
  },
  {
    id: 'http:fiscal-inbound-import-summary-v1',
    kind: 'http',
    description: 'One imported supplier NF-e in a tenant-scoped list.',
    schema: fiscalInboundImportSummarySchema,
  },
  {
    id: 'http:fiscal-inbound-import-v1',
    kind: 'http',
    description:
      'An imported supplier NF-e with lines, conflicts, proposals and its reconciliation.',
    schema: fiscalInboundImportSchema,
  },
  {
    id: 'http:fiscal-inbound-comparison-v1',
    kind: 'http',
    description: 'Line-by-line comparison of a supplier NF-e with received purchase lines.',
    schema: fiscalInboundComparisonSchema,
  },
  {
    id: 'http:fiscal-inbound-reconciliation-v1',
    kind: 'http',
    description: 'An immutable reviewed reconciliation of a supplier NF-e.',
    schema: fiscalInboundReconciliationSchema,
  },
  {
    id: 'http:fiscal-inbound-reconciliation-request-v1',
    kind: 'http',
    description: 'Reviewer allocations of supplier NF-e lines to received purchase lines.',
    schema: fiscalInboundReconciliationRequestSchema,
  },
  {
    id: 'http:fiscal-inbound-conflict-dismissal-request-v1',
    kind: 'http',
    description: 'Reviewed reason to dismiss a conflicting duplicate supplier NF-e.',
    schema: fiscalInboundConflictDismissalRequestSchema,
  },
  {
    id: 'http:fiscal-document-kind-v1',
    kind: 'http',
    description: 'Every NF-e document kind Horizon names, supported or not.',
    schema: fiscalDocumentKindSchema,
  },
  {
    id: 'http:fiscal-linked-kind-v1',
    kind: 'http',
    description: 'Document kinds that reference an earlier document.',
    schema: fiscalLinkedKindSchema,
  },
  {
    id: 'http:fiscal-document-kind-entry-v1',
    kind: 'http',
    description: 'One catalogued document kind with its reference, source and effect owners.',
    schema: fiscalDocumentKindEntrySchema,
  },
  {
    id: 'http:fiscal-correction-letter-status-v1',
    kind: 'http',
    description: 'Simulated correction letter status.',
    schema: fiscalCorrectionLetterStatusSchema,
  },
  {
    id: 'http:fiscal-document-kind-catalogue-v1',
    kind: 'http',
    description: 'Document kinds and model event flows, each supported or refused with a reason.',
    schema: fiscalDocumentKindCatalogueSchema,
  },
  {
    id: 'http:fiscal-linked-origin-request-v1',
    kind: 'http',
    description: 'Freeze a sale return, purchase return or value complement from owner facts.',
    schema: fiscalLinkedOriginRequestSchema,
  },
  {
    id: 'http:fiscal-linked-origin-v1',
    kind: 'http',
    description: 'An immutable linked origin, ready to become a linked NF-e draft.',
    schema: fiscalLinkedOriginSchema,
  },
  {
    id: 'http:fiscal-linked-problem-code-v1',
    kind: 'http',
    description: 'Stable refusal codes for linked origins.',
    schema: fiscalLinkedProblemCodeSchema,
  },
  {
    id: 'http:fiscal-consumer-problem-code-v1',
    kind: 'http',
    description: 'Stable refusal codes for NFC-e model 65 documents.',
    schema: fiscalConsumerProblemCodeSchema,
  },
  {
    id: 'http:fiscal-document-model-v1',
    kind: 'http',
    description: 'Document model of a Fiscal document: NF-e 55 or NFC-e 65.',
    schema: fiscalDocumentModelSchema,
  },
  {
    id: 'http:fiscal-document-create-request-v2',
    kind: 'http',
    description: 'Create a simulated NF-e 55 or, from a Sales intent, an NFC-e 65 draft.',
    schema: fiscalDocumentCreateRequestV2Schema,
  },
  {
    id: 'http:fiscal-document-v3',
    kind: 'http',
    description: 'A Fiscal document of either model; model 55 documents also satisfy v2.',
    schema: fiscalDocumentV3Schema,
  },
  {
    id: 'http:fiscal-ready-document-v2',
    kind: 'http',
    description: 'A calculation-locked document of either model with its digests.',
    schema: fiscalReadyDocumentV2Schema,
  },
  {
    id: 'http:fiscal-service-profile-request-v1',
    kind: 'http',
    description: 'Reviewed service fiscal profile revision for a Catalog service item.',
    schema: fiscalServiceProfileRequestSchema,
  },
  {
    id: 'http:fiscal-service-profile-v1',
    kind: 'http',
    description: 'One immutable service fiscal profile revision.',
    schema: fiscalServiceProfileSchema,
  },
  {
    id: 'http:fiscal-service-profile-list-v1',
    kind: 'http',
    description: 'Every revision of a service fiscal profile.',
    schema: fiscalServiceProfileListSchema,
  },
  {
    id: 'http:fiscal-nfse-registry-entry-v1',
    kind: 'http',
    description: 'One municipality of a versioned NFS-e registry.',
    schema: fiscalNfseRegistryEntrySchema,
  },
  {
    id: 'http:fiscal-nfse-registry-version-request-v1',
    kind: 'http',
    description: 'Import a versioned NFS-e municipal registry from the official adhesion list.',
    schema: fiscalNfseRegistryVersionRequestSchema,
  },
  {
    id: 'http:fiscal-nfse-registry-version-v1',
    kind: 'http',
    description: 'An imported NFS-e municipal registry version and its review.',
    schema: fiscalNfseRegistryVersionSchema,
  },
  {
    id: 'http:fiscal-nfse-registry-review-request-v1',
    kind: 'http',
    description: 'Reviewer interpretation approving an NFS-e registry version.',
    schema: fiscalNfseRegistryReviewRequestSchema,
  },
  {
    id: 'http:fiscal-nfse-municipality-resolution-v1',
    kind: 'http',
    description:
      'Whether the national NFS-e system issues for a municipality on a competence date.',
    schema: fiscalNfseMunicipalityResolutionSchema,
  },
  {
    id: 'http:fiscal-service-source-key-v1',
    kind: 'http',
    description: 'Owner fact that maps to exactly one service origin.',
    schema: fiscalServiceSourceKeySchema,
  },
  {
    id: 'http:fiscal-service-origin-request-v1',
    kind: 'http',
    description: 'Freeze a reviewed service provision with its competence date.',
    schema: fiscalServiceOriginRequestSchema,
  },
  {
    id: 'http:fiscal-service-origin-v1',
    kind: 'http',
    description: 'An immutable service origin, ready to become an NFS-e draft.',
    schema: fiscalServiceOriginSchema,
  },
  {
    id: 'http:fiscal-service-document-create-request-v1',
    kind: 'http',
    description: 'Create a simulated national NFS-e draft from a service origin.',
    schema: fiscalServiceDocumentCreateRequestSchema,
  },
  {
    id: 'http:fiscal-service-document-v1',
    kind: 'http',
    description: 'A simulated national NFS-e with its DPS, key and substitution links.',
    schema: fiscalServiceDocumentSchema,
  },
  {
    id: 'http:fiscal-service-cancellation-request-v1',
    kind: 'http',
    description: 'Reason code and text for NFS-e cancellation event 101101.',
    schema: fiscalServiceCancellationRequestSchema,
  },
  {
    id: 'http:fiscal-service-substitution-request-v1',
    kind: 'http',
    description: 'Substitute an NFS-e with a corrected service origin (event 105102).',
    schema: fiscalServiceSubstitutionRequestSchema,
  },
  {
    id: 'http:fiscal-service-problem-code-v1',
    kind: 'http',
    description: 'Stable refusal codes for national NFS-e documents.',
    schema: fiscalServiceProblemCodeSchema,
  },
  {
    id: 'http:fiscal-service-issuance-policy-request-v1',
    kind: 'http',
    description: 'Set whether an establishment issues delivered services by review or at once.',
    schema: fiscalServiceIssuancePolicyRequestSchema,
  },
  {
    id: 'http:fiscal-service-issuance-policy-v1',
    kind: 'http',
    description: 'The NFS-e issuance policy of one establishment, or the default.',
    schema: fiscalServiceIssuancePolicySchema,
  },
  {
    id: 'http:fiscal-service-intake-status-v1',
    kind: 'http',
    description: 'Where a delivered service line is on its way to an NFS-e.',
    schema: fiscalServiceIntakeStatusSchema,
  },
  {
    id: 'http:fiscal-service-intake-v1',
    kind: 'http',
    description: 'One delivered service line from Sales, its origin, draft and any block.',
    schema: fiscalServiceIntakeSchema,
  },
  {
    id: 'http:fiscal-service-intake-list-v1',
    kind: 'http',
    description: 'Delivered service lines received by Fiscal, newest first.',
    schema: fiscalServiceIntakeListSchema,
  },
  {
    id: 'http:fiscal-document-kind-entry-v2',
    kind: 'http',
    description: 'One catalogued document kind of any model, NFC-e 65 included.',
    schema: fiscalDocumentKindEntryV2Schema,
  },
  {
    id: 'http:fiscal-document-kind-catalogue-v2',
    kind: 'http',
    description: 'Document kinds of every model and their event flows.',
    schema: fiscalDocumentKindCatalogueV2Schema,
  },
  {
    id: 'http:fiscal-document-links-v1',
    kind: 'http',
    description:
      'References, linked documents, conserved quantities and effect owners of a document.',
    schema: fiscalDocumentLinksSchema,
  },
  {
    id: 'http:fiscal-correction-letter-request-v1',
    kind: 'http',
    description: 'Correction letter text with the attestation of its legal limits.',
    schema: fiscalCorrectionLetterRequestSchema,
  },
  {
    id: 'http:fiscal-correction-letter-v1',
    kind: 'http',
    description: 'One simulated correction letter event linked to an authorized NF-e.',
    schema: fiscalCorrectionLetterSchema,
  },
  {
    id: 'http:fiscal-correction-letter-list-v1',
    kind: 'http',
    description: 'Correction letters of a document in sequence order.',
    schema: fiscalCorrectionLetterListSchema,
  },
  {
    id: 'http:fiscal-document-summary-v1',
    kind: 'http',
    description: 'One row of the Fiscal operator worklist, of any model.',
    schema: fiscalDocumentSummarySchema,
  },
  {
    id: 'http:fiscal-document-list-v1',
    kind: 'http',
    description: 'Keyset page of the Fiscal operator worklist.',
    schema: fiscalDocumentListSchema,
  },
  {
    id: 'http:fiscal-support-overview-v1',
    kind: 'http',
    description: 'Counts and ages an operator needs to support one tenant Fiscal context.',
    schema: fiscalSupportOverviewSchema,
  },
  {
    id: 'http:problem-details',
    kind: 'http',
    description: 'RFC 9457 error body, returned by every endpoint in every module.',
    schema: problemDetailsSchema,
  },
  {
    id: 'http:validation-problem',
    kind: 'http',
    description: 'RFC 9457 body for a request that failed schema validation.',
    schema: validationProblemSchema,
  },
  {
    id: 'http:pagination-query',
    kind: 'http',
    description: 'Keyset pagination request parameters.',
    schema: paginationQuerySchema,
  },
  {
    id: 'http:page-info',
    kind: 'http',
    description: 'Keyset pagination response metadata.',
    schema: pageInfoSchema,
  },
  {
    id: 'http:reporting-journal-seal',
    kind: 'http',
    description:
      "A producer's count of a tenant's outbox rows up to an instant, sent to the reporting replay queue (ADR 0058).",
    schema: journalSealSchema,
  },
  {
    id: 'http:import-field',
    kind: 'http',
    description: 'One column an importer understands, with the headers it recognises.',
    schema: importFieldSchema,
  },
  {
    id: 'http:import-progress',
    kind: 'http',
    description:
      'Where every row of an import is: total = written + failed + remaining + cancelled.',
    schema: importProgressSchema,
  },
  {
    id: 'http:import-row-error',
    kind: 'http',
    description: 'A refused import row: its line in the file and every reason.',
    schema: importRowErrorSchema,
  },
  {
    id: 'http:import-kind',
    kind: 'http',
    description: 'A kind of bulk import a module offers, and the fields it maps (ADR 0059).',
    schema: importKindSchema,
  },
  {
    id: 'http:import-upload',
    kind: 'http',
    description: 'A CSV or XLSX file sent to a module to start an import job (ADR 0059).',
    schema: importUploadSchema,
  },
  {
    id: 'http:import-mapping',
    kind: 'http',
    description: "An import job's field-to-column mapping (ADR 0059).",
    schema: importMappingSchema,
  },
  {
    id: 'http:import-job',
    kind: 'http',
    description:
      'A bulk import job in its owning module, with progress that accounts for every row (ADR 0059).',
    schema: importJobSchema,
  },
  {
    id: 'http:import-preview',
    kind: 'http',
    description:
      "An import job's counts, first errors and first valid rows, shown before confirming.",
    schema: importPreviewSchema,
  },
  {
    id: 'http:attachment-request',
    kind: 'http',
    description:
      'Asking files for an upload slot on a record of an owning module, with the type and size (ADR 0060).',
    schema: attachmentRequestSchema,
  },
  {
    id: 'http:attachment',
    kind: 'http',
    description:
      'A file attached to a record, in its lifecycle: uploading, scanning, available, quarantined or deleted.',
    schema: attachmentSchema,
  },
  {
    id: 'http:attachment-link',
    kind: 'http',
    description: 'A signed, short-lived link to upload an attachment or download it.',
    schema: attachmentLinkSchema,
  },
  {
    id: 'http:segregation-of-duties-problem',
    kind: 'http',
    description:
      'The 403 every module answers when one person would hold both duties of a declared pair (ADR 0062).',
    schema: segregationOfDutiesProblemSchema,
  },
  {
    id: 'http:delegation-grant',
    kind: 'http',
    description: 'Lending an approval held through a role to a colleague for a period (ADR 0062).',
    schema: grantDelegationSchema,
  },
  {
    id: 'http:delegation',
    kind: 'http',
    description: 'An approval delegation in its owning module, with its state.',
    schema: delegationSchema,
  },
  {
    id: 'http:audit-query',
    kind: 'http',
    description: "The filters and cursor of a module's audit read endpoint.",
    schema: auditQuerySchema,
  },
  {
    id: 'http:audit-entry',
    kind: 'http',
    description: 'One row of a module audit log, as its read endpoint shows it.',
    schema: auditEntrySchema,
  },
  {
    id: 'http:audit-chain',
    kind: 'http',
    description: "The hash chain's verdict on one page of an audit log (ADR 0025).",
    schema: auditChainSchema,
  },
  {
    id: 'http:audit-page',
    kind: 'http',
    description: 'A page of a module audit log, newest first, with the chain verdict.',
    schema: auditPageSchema,
  },
  {
    id: 'http:consistency-run',
    kind: 'http',
    description:
      'A consistency run: owner figures against their ledger accounts, and every audit chain (ADR 0063).',
    schema: consistencyRunSchema,
  },
  {
    id: 'authorization:role-assignment',
    kind: 'authorization',
    description: 'A { module, role } pair. Identity stores these opaquely.',
    schema: roleAssignmentSchema,
  },
  {
    id: 'authorization:permission-id',
    kind: 'authorization',
    description: 'The <module>:<subject>:<action> permission identifier format.',
    schema: permissionIdSchema,
  },
]

const eventEntries: readonly RegistryEntry[] = EVENTS.map((event) => ({
  id: event.id,
  kind: 'event' as const,
  description: event.description,
  schema: event.payload,
}))

export const SCHEMA_REGISTRY: readonly RegistryEntry[] = [...staticEntries, ...eventEntries]

/** JSON Schema for every registered entry, keyed by id. Stable output, sorted by id. */
export function toJsonSchemas(): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const entry of [...SCHEMA_REGISTRY].sort((a, b) => a.id.localeCompare(b.id))) {
    output[entry.id] = z.toJSONSchema(entry.schema, { io: 'input' })
  }
  return output
}
