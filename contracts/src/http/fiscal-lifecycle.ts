import { z } from 'zod'

import { dateSchema, instantSchema, moneySchema, quantitySchema, uuidSchema } from '../common'

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)

export const fiscalDocumentStatusSchema = z.enum([
  'draft',
  'ready',
  'queued',
  'submitted',
  'unknown',
  'authorized',
  'rejected',
  'cancellation_pending',
  'cancellation_unknown',
  'cancelled',
])

export const fiscalCapabilitySchema = z.strictObject({
  id: uuidSchema,
  model: z.literal('55'),
  environment: z.literal('simulation'),
  establishmentId: uuidSchema,
  jurisdiction: z.strictObject({ kind: z.literal('uf'), code: z.string().regex(/^[A-Z]{2}$/) }),
  operation: z.literal('normal-sale'),
  adapterVersion: z.string().min(1).max(80),
  status: z.literal('simulated'),
  sourceManifestDigest: sha256Schema,
  schemaPackageDigest: sha256Schema,
  calculationFixtureId: z.string().min(1).max(160),
  evidenceDigest: sha256Schema,
  activatedAt: instantSchema,
})

export const fiscalCapabilityListSchema = z.strictObject({
  defaultStatus: z.literal('unsupported'),
  supported: z.array(fiscalCapabilitySchema),
})

const fiscalCapabilityV2Base = z.strictObject({
  id: uuidSchema,
  model: z.literal('55'),
  establishmentId: uuidSchema,
  jurisdiction: z.strictObject({ kind: z.literal('uf'), code: z.string().regex(/^[A-Z]{2}$/) }),
  operation: z.literal('normal-sale'),
  adapterVersion: z.string().min(1).max(80),
  sourceManifestDigest: sha256Schema,
  schemaPackageDigest: sha256Schema,
  calculationFixtureId: z.string().min(1).max(160),
  evidenceDigest: sha256Schema,
  activatedAt: instantSchema,
  fiscalValue: z.literal(false),
})

/** Version 2 adds a reviewed homologation read model without changing version 1. */
export const fiscalCapabilityV2Schema = z.discriminatedUnion('environment', [
  fiscalCapabilityV2Base.extend({
    environment: z.literal('simulation'),
    status: z.literal('simulated'),
  }),
  fiscalCapabilityV2Base.extend({
    environment: z.literal('homologation'),
    status: z.literal('homologated'),
  }),
])

export const fiscalCapabilityListV2Schema = z.strictObject({
  defaultStatus: z.literal('unsupported'),
  supported: z.array(fiscalCapabilityV2Schema),
})

const fiscalManualLineSchema = z.strictObject({
  lineId: uuidSchema,
  itemId: uuidSchema,
  catalogRevision: z.number().int().positive(),
  quantity: quantitySchema,
  unitPrice: moneySchema,
})

export const fiscalManualOriginRequestSchema = z.strictObject({
  establishmentId: uuidSchema,
  issuerProfileRevision: z.number().int().positive(),
  recipientPartyId: uuidSchema,
  recipientProfileRevision: z.number().int().positive(),
  issueDate: dateSchema,
  operation: z.literal('normal-sale'),
  purpose: z.literal('normal'),
  reason: z.string().trim().min(10).max(1000),
  lines: z.array(fiscalManualLineSchema).min(1).max(990),
})

export const fiscalManualOriginSchema = z.strictObject({
  id: uuidSchema,
  digest: sha256Schema,
  createdAt: instantSchema,
})

const fiscalDocumentOriginSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('sales'), intentId: uuidSchema }),
  z.strictObject({ kind: z.literal('manual'), manualOriginId: uuidSchema }),
  z.strictObject({ kind: z.literal('linked'), linkedOriginId: uuidSchema }),
])

export const fiscalDocumentCreateRequestSchema = z.strictObject({
  origin: fiscalDocumentOriginSchema,
  model: z.literal('55'),
  environment: z.literal('simulation'),
  establishmentId: uuidSchema,
  series: z.number().int().min(0).max(999),
})

export const fiscalDocumentSchema = z.strictObject({
  id: uuidSchema,
  rootDocumentId: uuidSchema,
  predecessorDocumentId: uuidSchema.nullable(),
  revision: z.number().int().positive(),
  origin: fiscalDocumentOriginSchema,
  status: fiscalDocumentStatusSchema,
  simulated: z.literal(true),
  model: z.literal('55'),
  environment: z.literal('simulation'),
  establishmentId: uuidSchema,
  series: z.number().int().min(0).max(999),
  number: z.number().int().min(1).max(999_999_999).nullable(),
  accessKey: z
    .string()
    .regex(/^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$/)
    .nullable(),
  snapshotDigest: sha256Schema,
  calculationDigest: sha256Schema.nullable(),
  signedXmlDigest: sha256Schema.nullable(),
  adapterVersion: z.string().min(1).max(80).nullable(),
  schemaPackageDigest: sha256Schema.nullable(),
  statusUrl: z.string().startsWith('/fiscal/documents/'),
  createdAt: instantSchema,
})

const fiscalDocumentV2Base = fiscalDocumentSchema
  .omit({
    environment: true,
    simulated: true,
  })
  .extend({ fiscalValue: z.literal(false) })

export const fiscalDocumentV2Schema = z.discriminatedUnion('environment', [
  fiscalDocumentV2Base.extend({
    environment: z.literal('simulation'),
    simulated: z.literal(true),
  }),
  fiscalDocumentV2Base.extend({
    environment: z.literal('homologation'),
    simulated: z.literal(false),
  }),
])

export const fiscalReadyDocumentSchema = z.strictObject({
  document: fiscalDocumentSchema,
  inputDigest: sha256Schema,
  rulesDigest: sha256Schema,
  resultDigest: sha256Schema,
  reconciliationDigest: sha256Schema,
})

export const fiscalCommandAcceptedSchema = z.strictObject({
  commandId: uuidSchema,
  documentId: uuidSchema,
  status: z.enum(['queued', 'cancellation_pending']),
  statusUrl: z.string().startsWith('/fiscal/documents/'),
  simulated: z.literal(true),
})

export const fiscalCancellationRequestSchema = z.strictObject({
  reason: z.string().trim().min(15).max(255),
})

export const fiscalCorrectionRequestSchema = z.strictObject({
  reason: z.string().trim().min(10).max(1000),
  correctedOrigin: fiscalDocumentOriginSchema,
})

export const fiscalDocumentTransitionSchema = z.strictObject({
  id: uuidSchema,
  documentId: uuidSchema,
  from: fiscalDocumentStatusSchema.nullable(),
  to: fiscalDocumentStatusSchema,
  actorId: z.string().min(1).max(200),
  commandId: uuidSchema.nullable(),
  reason: z.string().max(1000).nullable(),
  correlationId: z.string().max(256).nullable(),
  occurredAt: instantSchema,
})

export const fiscalDocumentTimelineSchema = z.strictObject({
  documentId: uuidSchema,
  transitions: z.array(fiscalDocumentTransitionSchema),
})

export const fiscalArtifactKindSchema = z.enum([
  'unsigned_xml',
  'signed_xml',
  'issuance_request',
  'issuance_response',
  'authorization_protocol',
  'cancellation_request',
  'cancellation_response',
  'cancellation_protocol',
  'danfe',
  'correction_request',
  'correction_response',
  'correction_protocol',
])

export const fiscalArtifactKindV2Schema = z.union([
  fiscalArtifactKindSchema,
  z.enum(['homologation_request', 'homologation_response', 'homologation_protocol']),
])

export const fiscalArtifactMetadataSchema = z.strictObject({
  documentId: uuidSchema,
  kind: fiscalArtifactKindSchema,
  digest: sha256Schema,
  byteSize: z.number().int().positive(),
  mediaType: z.string().min(3).max(100),
  sourceSchema: z.string().min(1).max(160),
  simulated: z.literal(true),
  createdAt: instantSchema,
})

const fiscalArtifactV2Base = fiscalArtifactMetadataSchema
  .omit({ simulated: true, kind: true })
  .extend({ kind: fiscalArtifactKindV2Schema, fiscalValue: z.literal(false) })

export const fiscalArtifactMetadataV2Schema = z.discriminatedUnion('environment', [
  fiscalArtifactV2Base.extend({ environment: z.literal('simulation'), simulated: z.literal(true) }),
  fiscalArtifactV2Base.extend({
    environment: z.literal('homologation'),
    simulated: z.literal(false),
  }),
])

export const fiscalArtifactListV2Schema = z.strictObject({
  documentId: uuidSchema,
  environment: z.enum(['simulation', 'homologation']),
  fiscalValue: z.literal(false),
  artifacts: z.array(fiscalArtifactMetadataV2Schema),
})

export const fiscalLifecycleProblemCodeSchema = z.enum([
  'CAPABILITY_UNSUPPORTED',
  'DOCUMENT_NOT_READY',
  'CALCULATION_MISMATCH',
  'INVALID_STATE_TRANSITION',
  'XML_SCHEMA_INVALID',
  'SIGNATURE_FAILED',
  'ISSUANCE_OUTCOME_UNKNOWN',
  'CONFLICTING_OBSERVATION',
  'CANCELLATION_NOT_ALLOWED',
])

export type FiscalDocumentStatus = z.infer<typeof fiscalDocumentStatusSchema>
export type FiscalCapability = z.infer<typeof fiscalCapabilitySchema>
export type FiscalCapabilityList = z.infer<typeof fiscalCapabilityListSchema>
export type FiscalCapabilityV2 = z.infer<typeof fiscalCapabilityV2Schema>
export type FiscalCapabilityListV2 = z.infer<typeof fiscalCapabilityListV2Schema>
export type FiscalManualOriginRequest = z.infer<typeof fiscalManualOriginRequestSchema>
export type FiscalDocumentCreateRequest = z.infer<typeof fiscalDocumentCreateRequestSchema>
export type FiscalDocument = z.infer<typeof fiscalDocumentSchema>
export type FiscalDocumentV2 = z.infer<typeof fiscalDocumentV2Schema>
export type FiscalReadyDocument = z.infer<typeof fiscalReadyDocumentSchema>
export type FiscalCommandAccepted = z.infer<typeof fiscalCommandAcceptedSchema>
export type FiscalCancellationRequest = z.infer<typeof fiscalCancellationRequestSchema>
export type FiscalCorrectionRequest = z.infer<typeof fiscalCorrectionRequestSchema>
export type FiscalDocumentTimeline = z.infer<typeof fiscalDocumentTimelineSchema>
export type FiscalArtifactMetadata = z.infer<typeof fiscalArtifactMetadataSchema>
export type FiscalArtifactMetadataV2 = z.infer<typeof fiscalArtifactMetadataV2Schema>
export type FiscalArtifactListV2 = z.infer<typeof fiscalArtifactListV2Schema>
export type FiscalLifecycleProblemCode = z.infer<typeof fiscalLifecycleProblemCodeSchema>
