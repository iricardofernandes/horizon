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
export type FiscalManualOriginRequest = z.infer<typeof fiscalManualOriginRequestSchema>
export type FiscalDocumentCreateRequest = z.infer<typeof fiscalDocumentCreateRequestSchema>
export type FiscalDocument = z.infer<typeof fiscalDocumentSchema>
export type FiscalReadyDocument = z.infer<typeof fiscalReadyDocumentSchema>
export type FiscalCommandAccepted = z.infer<typeof fiscalCommandAcceptedSchema>
export type FiscalCancellationRequest = z.infer<typeof fiscalCancellationRequestSchema>
export type FiscalCorrectionRequest = z.infer<typeof fiscalCorrectionRequestSchema>
export type FiscalDocumentTimeline = z.infer<typeof fiscalDocumentTimelineSchema>
export type FiscalArtifactMetadata = z.infer<typeof fiscalArtifactMetadataSchema>
export type FiscalLifecycleProblemCode = z.infer<typeof fiscalLifecycleProblemCodeSchema>
