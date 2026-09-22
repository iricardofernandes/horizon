import { z } from 'zod'

import { currencySchema, dateSchema, moneySchema, tenantIdSchema, uuidSchema } from '../common'

const canonicalUnsignedDecimalSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)(\.\d{1,6})?$/,
    'must be a canonical non-negative decimal with at most 6 places',
  )

const nonNegativeMoneySchema = moneySchema.refine(
  ({ amount }) => !amount.startsWith('-'),
  'must not be negative',
)

const fiscalCalculationInputBaseSchema = z.object({
  schemaVersion: z.literal(1),
  tenantId: tenantIdSchema,
  issuerEstablishmentId: uuidSchema,
  issuerProfileRevision: z.int().positive().optional(),
  recipientPartyId: uuidSchema.optional(),
  recipientProfileRevision: z.int().positive().optional(),
  model: z.enum(['55', '65', 'nfse']),
  environment: z.enum(['simulation', 'homologation', 'production']),
  operation: z.string().trim().min(1).max(80),
  purpose: z.enum(['normal', 'return', 'complementary', 'adjustment']),
  referencedDocumentId: uuidSchema.optional(),
  issuer: z.object({
    regime: z.string().trim().min(1).max(80),
    stateCode: z.string().regex(/^\d{2}$/),
    municipalityCode: z.string().regex(/^\d{7}$/),
  }),
  recipient: z.object({
    regime: z.string().trim().min(1).max(80),
    stateCode: z.string().regex(/^\d{2}$/),
    municipalityCode: z.string().regex(/^\d{7}$/),
    taxpayer: z.boolean(),
  }),
  origin: z.object({
    countryCode: z.string().regex(/^\d{4}$/),
    stateCode: z.string().regex(/^\d{2}$/),
    municipalityCode: z.string().regex(/^\d{7}$/),
  }),
  destination: z.object({
    countryCode: z.string().regex(/^\d{4}$/),
    stateCode: z.string().regex(/^\d{2}$/),
    municipalityCode: z.string().regex(/^\d{7}$/),
  }),
  issueDate: dateSchema,
  competenceDate: dateSchema.optional(),
  currency: currencySchema,
  lines: z
    .array(
      z.object({
        id: uuidSchema,
        itemId: uuidSchema.optional(),
        serviceId: uuidSchema.optional(),
        classificationRevision: z.int().positive().optional(),
        quantity: canonicalUnsignedDecimalSchema,
        unitPrice: canonicalUnsignedDecimalSchema,
        discount: nonNegativeMoneySchema,
        charges: nonNegativeMoneySchema,
        classifications: z.object({
          ncm: z
            .string()
            .regex(/^\d{8}$/)
            .optional(),
          cest: z
            .string()
            .regex(/^\d{7}$/)
            .optional(),
          service: z.string().trim().min(1).max(40).optional(),
          origin: z.string().trim().min(1).max(10).optional(),
        }),
        taxFacts: z.record(z.string().min(1).max(80), z.string().max(200)).default({}),
      }),
    )
    .min(1)
    .max(1000),
})

export const fiscalCalculationInputSchema = fiscalCalculationInputBaseSchema.superRefine(
  (input, context) => validateCalculationInput(input, context),
)

function validateCalculationInput(
  input: z.infer<typeof fiscalCalculationInputBaseSchema>,
  context: z.RefinementCtx,
) {
  if (input.purpose === 'return' && !input.referencedDocumentId)
    context.addIssue({
      code: 'custom',
      path: ['referencedDocumentId'],
      message: 'is required for a return',
    })
  for (const [index, line] of input.lines.entries())
    validateCalculationLine(line, index, input.currency, context)
}

function validateCalculationLine(
  line: z.infer<typeof fiscalCalculationInputBaseSchema>['lines'][number],
  index: number,
  currency: string,
  context: z.RefinementCtx,
) {
  if ((line.itemId ? 1 : 0) + (line.serviceId ? 1 : 0) !== 1)
    context.addIssue({
      code: 'custom',
      path: ['lines', index],
      message: 'must identify exactly one item or service',
    })
  for (const field of ['discount', 'charges'] as const) {
    if (line[field].currency !== currency)
      context.addIssue({
        code: 'custom',
        path: ['lines', index, field, 'currency'],
        message: 'must match the document currency',
      })
  }
}

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/)
const integerStringSchema = z.string().regex(/^-?\d+$/)

export const fiscalCalculationResultSchema = z.object({
  schemaVersion: z.literal(1),
  supported: z.literal(true),
  inputDigest: digestSchema,
  rulesDigest: digestSchema,
  resultDigest: digestSchema,
  lines: z.array(
    z.object({
      lineId: uuidSchema,
      gross: moneySchema,
      net: moneySchema,
      components: z.object({
        legacy: z.array(fiscalTaxComponentSchema()),
        ibsCbs: z.array(fiscalTaxComponentSchema()),
      }),
    }),
  ),
  totals: z.object({
    gross: moneySchema,
    discounts: moneySchema,
    charges: moneySchema,
    net: moneySchema,
    legacyTax: moneySchema,
    ibsCbsTax: moneySchema,
  }),
  reconciliation: z.object({
    lineNetSum: moneySchema,
    legacyComponentSum: moneySchema,
    ibsCbsComponentSum: moneySchema,
    balanced: z.literal(true),
  }),
  explanation: z.object({
    templateVersion: z.string().min(1).max(40),
    text: z.string().min(1),
  }),
})

function fiscalTaxComponentSchema() {
  return z.object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/),
    base: moneySchema,
    rate: z.object({
      numerator: integerStringSchema,
      denominator: z.string().regex(/^[1-9]\d*$/),
    }),
    unrounded: z.object({
      numerator: integerStringSchema,
      denominator: z.string().regex(/^[1-9]\d*$/),
      currency: currencySchema,
    }),
    amount: moneySchema,
    formula: z.string().min(1).max(120),
    rounding: z.object({ mode: z.literal('half-away-from-zero'), scale: z.int().min(0).max(6) }),
    rule: z.object({ id: uuidSchema, version: z.int().positive() }),
    source: z.object({
      packageId: uuidSchema,
      digest: digestSchema,
      uri: z.url(),
      section: z.string().min(1).max(200),
    }),
  })
}

export const fiscalCalculationProblemCodeSchema = z.enum([
  'UNSUPPORTED_RULE',
  'MISSING_CLASSIFICATION',
  'AMBIGUOUS_RULE',
  'SOURCE_NOT_APPROVED',
  'INVALID_FISCAL_INPUT',
])

export const fiscalUnsupportedCalculationSchema = z.object({
  schemaVersion: z.literal(1),
  supported: z.literal(false),
  code: fiscalCalculationProblemCodeSchema,
  detail: z.string().min(1),
  missingDimension: z.string().min(1).max(120).optional(),
  inputDigest: digestSchema.optional(),
})

export const fiscalCalculationOutcomeSchema = z.discriminatedUnion('supported', [
  fiscalCalculationResultSchema,
  fiscalUnsupportedCalculationSchema,
])

export type FiscalCalculationInput = z.infer<typeof fiscalCalculationInputSchema>
export type FiscalCalculationResult = z.infer<typeof fiscalCalculationResultSchema>
export type FiscalCalculationOutcome = z.infer<typeof fiscalCalculationOutcomeSchema>
export type FiscalCalculationProblemCode = z.infer<typeof fiscalCalculationProblemCodeSchema>
