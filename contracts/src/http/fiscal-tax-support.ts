import { z } from 'zod'

import { dateSchema } from '../common'

/**
 * The tax support matrix (Phase 85, ADR 0072): the scenarios Fiscal calculates with evidence,
 * generated from the official calculator's agreement (IBS/CBS) and the workspace owner's
 * approved fixtures (the legacy taxes). Anything outside it is unsupported.
 */

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/)
const stateSchema = z.string().regex(/^\d{2}$/)
const componentCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/)

export const fiscalTaxSupportRowSchema = z.object({
  id: z.string().min(1).max(160),
  model: z.enum(['55', '65', 'nfse']),
  environment: z.enum(['simulation', 'homologation', 'production']),
  from: dateSchema,
  until: dateSchema,
  taxes: z.array(componentCodeSchema).min(1).max(16),
  /** A dimension that is absent is not constrained by this row. */
  dimensions: z.object({
    /** Absent for a scenario approved for an operation whatever the item (Phases 41 to 47). */
    classification: z
      .object({
        kind: z.enum(['ncm', 'service', 'class_trib']),
        code: z.string().min(1).max(40),
      })
      .optional(),
    operation: z.string().min(1).max(80).optional(),
    purpose: z.enum(['normal', 'return', 'complementary', 'adjustment']).optional(),
    originState: stateSchema.optional(),
    destinationState: stateSchema.optional(),
    recipientTaxpayer: z.boolean().optional(),
    issuerRegime: z.string().min(1).max(80).optional(),
    incomeTaxRegime: z.enum(['lucro-real', 'lucro-presumido']).optional(),
    issuerMunicipality: z
      .string()
      .regex(/^\d{7}$/)
      .optional(),
    origin: z.string().min(1).max(10).optional(),
    facts: z.record(z.string().min(1).max(40), z.string().min(1).max(80)).optional(),
  }),
  evidence: z.object({
    /** An approved scenario of Phases 41 to 47, recorded in its evidence rather than a fixture file. */
    kind: z.enum(['oracle', 'approved-fixture', 'approved-scenario']),
    reference: z.string().min(1).max(300),
    digest: digestSchema,
  }),
})

export const fiscalTaxSupportMatrixSchema = z.object({
  schemaVersion: z.literal(1),
  defaultStatus: z.literal('unsupported'),
  rows: z.array(fiscalTaxSupportRowSchema).max(10_000),
})

/** The dimensions a caller asks about, in the order they are checked. */
export const FISCAL_TAX_SUPPORT_DIMENSIONS = [
  'model',
  'date',
  'tax',
  'operation',
  'purpose',
  'classification',
  'originState',
  'destinationState',
  'recipientTaxpayer',
  'issuerRegime',
  'incomeTaxRegime',
  'issuerMunicipality',
  'origin',
  'facts',
] as const

export const fiscalTaxSupportQuerySchema = z.object({
  model: z.enum(['55', '65', 'nfse']),
  date: dateSchema,
  tax: componentCodeSchema,
  operation: z.string().min(1).max(80).optional(),
  purpose: z.enum(['normal', 'return', 'complementary', 'adjustment']).optional(),
  classification: z.object({
    kind: z.enum(['ncm', 'service', 'class_trib']),
    code: z.string().min(1).max(40),
  }),
  originState: stateSchema.optional(),
  destinationState: stateSchema.optional(),
  recipientTaxpayer: z.boolean().optional(),
  issuerRegime: z.string().min(1).max(80).optional(),
  incomeTaxRegime: z.enum(['lucro-real', 'lucro-presumido']).optional(),
  issuerMunicipality: z
    .string()
    .regex(/^\d{7}$/)
    .optional(),
  origin: z.string().min(1).max(10).optional(),
  /** The line's facts; a row's facts must all be stated with the same value. */
  facts: z.record(z.string().min(1).max(40), z.string().min(1).max(80)).optional(),
})

export const fiscalTaxSupportAnswerSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('supported'), rows: z.array(fiscalTaxSupportRowSchema).min(1) }),
  z.object({
    status: z.literal('unsupported'),
    missingDimension: z.enum(FISCAL_TAX_SUPPORT_DIMENSIONS),
  }),
])

export type FiscalTaxSupportRow = z.infer<typeof fiscalTaxSupportRowSchema>
export type FiscalTaxSupportMatrix = z.infer<typeof fiscalTaxSupportMatrixSchema>
export type FiscalTaxSupportQuery = z.infer<typeof fiscalTaxSupportQuerySchema>
export type FiscalTaxSupportAnswer = z.infer<typeof fiscalTaxSupportAnswerSchema>
