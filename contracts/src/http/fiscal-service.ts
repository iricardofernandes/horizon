import { z } from 'zod'

import { dateSchema, instantSchema, moneySchema, uuidSchema } from '../common'
import { fiscalDocumentStatusSchema } from './fiscal-lifecycle'

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)
const municipalityCodeSchema = z.string().regex(/^\d{7}$/)
const reasonSchema = z.string().trim().min(10).max(1000)

/**
 * A reviewed service fiscal profile revision for one Catalog service item. It is the
 * service counterpart of the goods classification: the national tax code (LC 116 item,
 * subitem and national split), the NBS code and the ISSQN treatment.
 */
export const fiscalServiceProfileRequestSchema = z.strictObject({
  itemId: uuidSchema,
  nationalTaxCode: z.string().regex(/^\d{6}$/),
  nbsCode: z.string().regex(/^\d{9}$/),
  municipalTaxCode: z.string().trim().min(1).max(20).optional(),
  /** Only a taxable operation (`tribISSQN` 1) is supported. */
  issTaxation: z.literal('1'),
  description: z.string().trim().min(1).max(2000),
  effectiveFrom: dateSchema,
  reason: reasonSchema,
})

export const fiscalServiceProfileSchema = z.strictObject({
  itemId: uuidSchema,
  revision: z.number().int().positive(),
  nationalTaxCode: z.string().regex(/^\d{6}$/),
  nbsCode: z.string().regex(/^\d{9}$/),
  municipalTaxCode: z.string().min(1).max(20).nullable(),
  issTaxation: z.literal('1'),
  description: z.string().min(1).max(2000),
  effectiveFrom: dateSchema,
  digest: sha256Schema,
  createdBy: z.string().min(1).max(200),
  createdAt: instantSchema,
})

export const fiscalServiceProfileListSchema = z.strictObject({
  itemId: uuidSchema,
  revisions: z.array(fiscalServiceProfileSchema),
})

/** One municipality in a versioned NFS-e registry, as the official adhesion list says. */
export const fiscalNfseRegistryEntrySchema = z.strictObject({
  municipalityCode: municipalityCodeSchema,
  uf: z.string().regex(/^[A-Z]{2}$/),
  name: z.string().trim().min(1).max(150),
  agreement: z.enum(['active', 'inactive']),
  nationalEnvironment: z.boolean(),
  nationalIssuer: z.boolean(),
  startsOn: dateSchema.nullable(),
  sourceLocator: z.string().trim().min(1).max(300),
})

export const fiscalNfseRegistryVersionRequestSchema = z.strictObject({
  sourceUri: z.url(),
  sourceDigest: sha256Schema,
  publishedOn: dateSchema,
  entries: z.array(fiscalNfseRegistryEntrySchema).min(1).max(6000),
})

export const fiscalNfseRegistryVersionSchema = z.strictObject({
  id: uuidSchema,
  sourceUri: z.url(),
  sourceDigest: sha256Schema,
  publishedOn: dateSchema,
  entryCount: z.number().int().positive(),
  digest: sha256Schema,
  reviewed: z.boolean(),
  reviewedBy: z.string().min(1).max(200).nullable(),
  reviewedAt: instantSchema.nullable(),
  createdAt: instantSchema,
  existing: z.boolean(),
})

export const fiscalNfseRegistryReviewRequestSchema = z.strictObject({
  interpretation: reasonSchema,
})

/** Whether the national system issues NFS-e for a municipality on a competence date. */
export const fiscalNfseMunicipalityResolutionSchema = z.strictObject({
  municipalityCode: municipalityCodeSchema,
  competenceDate: dateSchema,
  route: z.enum(['national', 'unsupported']),
  reason: z.string().min(1).max(300).nullable(),
  versionId: uuidSchema.nullable(),
  entry: fiscalNfseRegistryEntrySchema.nullable(),
})

/**
 * The owner fact a service origin comes from. Phase K sends contract periods through it:
 * the same key and facts always map to one fiscal origin.
 */
export const fiscalServiceSourceKeySchema = z.strictObject({
  module: z.string().regex(/^[a-z][a-z-]{1,39}$/),
  documentType: z.string().regex(/^[a-z][a-z-]{1,39}$/),
  id: uuidSchema,
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
})

export const fiscalServiceOriginRequestSchema = z.strictObject({
  establishmentId: uuidSchema,
  issuerProfileRevision: z.number().int().positive(),
  recipientPartyId: uuidSchema,
  recipientProfileRevision: z.number().int().positive(),
  serviceItemId: uuidSchema,
  serviceProfileRevision: z.number().int().positive(),
  competenceDate: dateSchema,
  amount: moneySchema,
  description: z.string().trim().min(1).max(2000),
  reason: reasonSchema,
  sourceKey: fiscalServiceSourceKeySchema.optional(),
})

export const fiscalServiceOriginSchema = z.strictObject({
  id: uuidSchema,
  digest: sha256Schema,
  createdAt: instantSchema,
  existing: z.boolean(),
})

export const fiscalServiceDocumentCreateRequestSchema = z.strictObject({
  serviceOriginId: uuidSchema,
  environment: z.literal('simulation'),
  establishmentId: uuidSchema,
  /** The DPS series; 1 to 999 lies inside the taxpayer-application range (E0010). */
  series: z.number().int().min(1).max(999),
})

export const fiscalServiceDocumentSchema = z.strictObject({
  id: uuidSchema,
  rootDocumentId: uuidSchema,
  predecessorDocumentId: uuidSchema.nullable(),
  revision: z.number().int().positive(),
  serviceOriginId: uuidSchema,
  substitutesDocumentId: uuidSchema.nullable(),
  substitutedByDocumentId: uuidSchema.nullable(),
  status: fiscalDocumentStatusSchema,
  model: z.literal('nfse'),
  environment: z.literal('simulation'),
  simulated: z.literal(true),
  fiscalValue: z.literal(false),
  establishmentId: uuidSchema,
  municipalityCode: municipalityCodeSchema.nullable(),
  competenceDate: dateSchema,
  series: z.number().int().min(1).max(999),
  number: z.number().int().min(1).max(999_999_999).nullable(),
  dpsId: z
    .string()
    .regex(/^DPS[0-9]{42}$/)
    .nullable(),
  nfseKey: z
    .string()
    .regex(/^[0-9]{50}$/)
    .nullable(),
  nfseNumber: z
    .string()
    .regex(/^[1-9][0-9]{0,12}$/)
    .nullable(),
  generatedAt: instantSchema.nullable(),
  snapshotDigest: sha256Schema,
  calculationDigest: sha256Schema.nullable(),
  dpsXmlDigest: sha256Schema.nullable(),
  adapterVersion: z.string().min(1).max(80).nullable(),
  statusUrl: z.string().startsWith('/fiscal/service-documents/'),
  createdAt: instantSchema,
})

/** Event 101101 reasons: 1 emission error, 2 service not provided, 9 other. */
export const fiscalServiceCancellationRequestSchema = z.strictObject({
  reasonCode: z.enum(['1', '2', '9']),
  reason: z.string().trim().min(15).max(255),
})

/** A substitute DPS that, once generated, cancels the original (event 105102). */
export const fiscalServiceSubstitutionRequestSchema = z
  .strictObject({
    reasonCode: z.enum(['01', '02', '03', '04', '05', '99']),
    reason: z.string().trim().min(15).max(255).optional(),
    correctedOrigin: z.strictObject({ serviceOriginId: uuidSchema }),
  })
  .refine((request) => request.reasonCode !== '99' || request.reason !== undefined, {
    path: ['reason'],
    message: 'is required for reason code 99',
  })

export const fiscalServiceProblemCodeSchema = z.enum([
  'MUNICIPALITY_UNSUPPORTED',
  'SERVICE_PROFILE_MISSING',
  'SUBSTITUTION_NOT_ALLOWED',
  'SOURCE_KEY_CONFLICT',
])

/**
 * How an establishment issues the NFS-e of services delivered in Sales (Phase 50):
 * `review` leaves each draft for a person, `automatic` validates and issues it at once.
 */
export const fiscalServiceIssuancePolicyRequestSchema = z.strictObject({
  mode: z.enum(['review', 'automatic']),
  series: z.number().int().min(1).max(999),
  reason: reasonSchema,
})

export const fiscalServiceIssuancePolicySchema = z.strictObject({
  establishmentId: uuidSchema,
  mode: z.enum(['review', 'automatic']),
  series: z.number().int().min(1).max(999),
  /** False when nothing was configured and the default (`review`, series 1) applies. */
  configured: z.boolean(),
  updatedBy: z.string().min(1).max(200).nullable(),
  updatedAt: instantSchema.nullable(),
})

export const fiscalServiceIntakeStatusSchema = z.enum([
  'pending',
  'blocked',
  'drafted',
  'issuing',
  'cancelling',
  'withdrawn',
  'cancellation-refused',
])

/**
 * One billed service line on its way to an NFS-e, and where it stopped if it did.
 *
 * A delivered line (`sourceKey.documentType` `service-delivery`) names its delivery and
 * service order; a billed contract period (`contract-period`, 0.40.0) names the billed
 * period and the contract instead.
 */
export const fiscalServiceIntakeSchema = z.strictObject({
  id: uuidSchema,
  sourceKey: fiscalServiceSourceKeySchema,
  deliveryId: uuidSchema.nullable(),
  serviceOrderId: uuidSchema.nullable(),
  billedPeriodId: uuidSchema.nullable().optional(),
  contractId: uuidSchema.nullable().optional(),
  customerId: uuidSchema,
  serviceItemId: uuidSchema,
  competenceDate: dateSchema,
  amount: moneySchema,
  status: fiscalServiceIntakeStatusSchema,
  reason: z.string().min(1).max(1000).nullable(),
  attempts: z.number().int().min(0),
  nextAttemptAt: instantSchema.nullable(),
  withdrawalRequested: z.boolean(),
  serviceOriginId: uuidSchema.nullable(),
  documentId: uuidSchema.nullable(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
})

export const fiscalServiceIntakeListSchema = z.strictObject({
  data: z.array(fiscalServiceIntakeSchema),
})

export type FiscalServiceProfileRequest = z.infer<typeof fiscalServiceProfileRequestSchema>
export type FiscalServiceProfile = z.infer<typeof fiscalServiceProfileSchema>
export type FiscalNfseRegistryEntry = z.infer<typeof fiscalNfseRegistryEntrySchema>
export type FiscalNfseRegistryVersionRequest = z.infer<
  typeof fiscalNfseRegistryVersionRequestSchema
>
export type FiscalNfseRegistryVersion = z.infer<typeof fiscalNfseRegistryVersionSchema>
export type FiscalNfseMunicipalityResolution = z.infer<
  typeof fiscalNfseMunicipalityResolutionSchema
>
export type FiscalServiceSourceKey = z.infer<typeof fiscalServiceSourceKeySchema>
export type FiscalServiceOriginRequest = z.infer<typeof fiscalServiceOriginRequestSchema>
export type FiscalServiceDocument = z.infer<typeof fiscalServiceDocumentSchema>
export type FiscalServiceSubstitutionRequest = z.infer<
  typeof fiscalServiceSubstitutionRequestSchema
>
export type FiscalServiceProblemCode = z.infer<typeof fiscalServiceProblemCodeSchema>
export type FiscalServiceIssuancePolicy = z.infer<typeof fiscalServiceIssuancePolicySchema>
export type FiscalServiceIntake = z.infer<typeof fiscalServiceIntakeSchema>
