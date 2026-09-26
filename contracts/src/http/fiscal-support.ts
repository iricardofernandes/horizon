import { z } from 'zod'

import { instantSchema, uuidSchema } from '../common'
import { fiscalDocumentStatusSchema } from './fiscal-lifecycle'
import { pageInfoSchema } from './pagination'

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)

/** Every document model Fiscal keeps, NFS-e included. */
const fiscalDocumentListModelSchema = z.enum(['55', '65', 'nfse'])

const fiscalDocumentOriginKindSchema = z.enum(['sales', 'manual', 'linked', 'service'])

const fiscalDispatchCommandKindSchema = z.enum([
  'issuance',
  'status_query',
  'cancellation',
  'cancellation_query',
])

/**
 * One row of the operator worklist. It names the model and status, the number the
 * document holds, and what is still pending, without any tax identifier or party data.
 */
export const fiscalDocumentSummarySchema = z.strictObject({
  id: uuidSchema,
  model: fiscalDocumentListModelSchema,
  environment: z.enum(['simulation', 'homologation']),
  simulated: z.boolean(),
  fiscalValue: z.literal(false),
  status: fiscalDocumentStatusSchema,
  originKind: fiscalDocumentOriginKindSchema,
  establishmentId: uuidSchema,
  series: z.number().int().min(0).max(999),
  number: z.number().int().min(1).max(999_999_999).nullable(),
  revision: z.number().int().positive(),
  /** The command still queued or leased for this document, if any. */
  pending: z
    .strictObject({
      kind: fiscalDispatchCommandKindSchema,
      state: z.enum(['pending', 'leased']),
      attemptCount: z.number().int().min(0),
      nextAttemptAt: instantSchema,
    })
    .nullable(),
  /** The last authority rejection code observed for this document. */
  lastRejectionCode: z.string().min(1).max(40).nullable(),
  statusUrl: z.string().startsWith('/fiscal/'),
  createdAt: instantSchema,
  updatedAt: instantSchema,
})

export const fiscalDocumentListSchema = z.strictObject({
  data: z.array(fiscalDocumentSummarySchema),
  page: pageInfoSchema,
})

const fiscalCertificateStateSchema = z.enum(['valid', 'expiring', 'expired'])

/**
 * What an operator needs to support one tenant's Fiscal context. Counts and ages only:
 * no access key, tax identifier, party or XML.
 */
export const fiscalSupportOverviewSchema = z.strictObject({
  generatedAt: instantSchema,
  simulationOnly: z.boolean(),
  queue: z.strictObject({
    pending: z.number().int().min(0),
    leased: z.number().int().min(0),
    /** Seconds since the oldest due pending command became due; 0 when none is due. */
    oldestDueSeconds: z.number().int().min(0),
    maxAttemptCount: z.number().int().min(0),
  }),
  documents: z.partialRecord(fiscalDocumentStatusSchema, z.number().int().min(0)),
  unknownOutcomes: z.number().int().min(0),
  rejections: z.array(
    z.strictObject({
      code: z.string().min(1).max(40),
      count: z.number().int().positive(),
      lastObservedAt: instantSchema,
    }),
  ),
  certificates: z.array(
    z.strictObject({
      establishmentId: uuidSchema,
      fingerprint: sha256Schema,
      validUntil: instantSchema,
      daysRemaining: z.number().int(),
      state: fiscalCertificateStateSchema,
    }),
  ),
  imports: z.strictObject({
    open: z.number().int().min(0),
    blocked: z.number().int().min(0),
    reconciled: z.number().int().min(0),
  }),
  outbox: z.strictObject({
    undelivered: z.number().int().min(0),
    oldestUndeliveredSeconds: z.number().int().min(0),
  }),
  /** Every active capability row of the tenant; anything absent is unsupported. */
  capabilities: z.array(
    z.strictObject({
      id: uuidSchema,
      model: fiscalDocumentListModelSchema,
      environment: z.enum(['simulation', 'homologation']),
      establishmentId: uuidSchema,
      jurisdiction: z.strictObject({
        kind: z.enum(['uf', 'municipality']),
        code: z.string().regex(/^([A-Z]{2}|\d{7})$/),
      }),
      operation: z.string().min(1).max(80),
      adapterVersion: z.string().min(1).max(80),
      status: z.enum(['simulated', 'homologated']),
      activatedAt: instantSchema,
    }),
  ),
  sourcePackages: z.array(
    z.strictObject({
      id: uuidSchema,
      authority: z.string().min(1).max(200),
      publishedAt: z.iso.date(),
      importedAt: instantSchema,
      ageDays: z.number().int().min(0),
    }),
  ),
})

export type FiscalDocumentSummary = z.infer<typeof fiscalDocumentSummarySchema>
export type FiscalDocumentList = z.infer<typeof fiscalDocumentListSchema>
export type FiscalSupportOverview = z.infer<typeof fiscalSupportOverviewSchema>
