import { z } from 'zod'

import { instantSchema, quantitySchema, uuidSchema } from '../common'

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)
const accessKeySchema = z.string().regex(/^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$/)
const decimal2Schema = z.string().regex(/^\d{1,13}\.\d{2}$/)
const minorSchema = z.string().regex(/^-?\d+$/)
const reasonSchema = z.string().trim().min(10).max(500)

/** `blocked` means an undismissed conflicting duplicate exists for the access key. */
export const fiscalInboundImportStatusSchema = z.enum(['open', 'blocked', 'reconciled'])

export const fiscalInboundDifferenceSchema = z.enum(['quantity', 'value', 'item', 'unmatched'])

export const fiscalInboundVerificationSchema = z.strictObject({
  sourceDigest: sha256Schema,
  contentDigest: sha256Schema,
  signature: z.literal('valid-unanchored'),
  signerTaxId: z.string().regex(/^[0-9A-Z]{14}$/),
  protocol: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('absent') }),
    z.strictObject({
      status: z.literal('authorized'),
      code: z.enum(['100', '150']),
      number: z.string().regex(/^\d{15}$/),
      receivedAt: z.string().min(1).max(40),
    }),
  ]),
  authorityStatus: z.literal('unverified'),
})

export const fiscalInboundImportSummarySchema = z.strictObject({
  id: uuidSchema,
  accessKey: accessKeySchema,
  series: z.number().int().min(0).max(999),
  number: z.number().int().min(1).max(999_999_999),
  issuedAt: z.string().min(1).max(40),
  authorityEnvironment: z.enum(['production', 'homologation']),
  supplierPartyId: uuidSchema.nullable(),
  invoiceTotal: decimal2Schema,
  lineCount: z.number().int().min(1).max(990),
  status: fiscalInboundImportStatusSchema,
  importedAt: instantSchema,
})

const taxSchema = z.strictObject({
  group: z.string().min(1).max(20),
  cst: z.string().max(4).nullable(),
  base: z.string().max(20).nullable(),
  rate: z.string().max(20).nullable(),
  value: z.string().max(20).nullable(),
})

const invoiceLineSchema = z.strictObject({
  number: z.number().int().min(1).max(990),
  productCode: z.string().min(1).max(60),
  gtin: z.string().max(14).nullable(),
  description: z.string().min(1).max(120),
  ncm: z.string().regex(/^\d{2}(\d{6})?$/),
  cfop: z.string().regex(/^\d{4}$/),
  unit: z.string().min(1).max(6),
  quantity: z.string().min(1).max(20),
  unitPrice: z.string().min(1).max(30),
  gross: decimal2Schema,
  discount: decimal2Schema,
  orderReference: z.string().max(15).nullable(),
  orderLineReference: z.string().max(6).nullable(),
  taxes: z.array(taxSchema).max(20),
})

const allocationSchema = z.strictObject({
  receiptId: uuidSchema,
  receiptLineId: uuidSchema,
  quantity: quantitySchema,
})

export const fiscalInboundComparisonSchema = z.strictObject({
  currency: z.literal('BRL'),
  invoicedValueMinor: minorSchema,
  expectedValueMinor: minorSchema,
  clean: z.boolean(),
  lines: z.array(
    z.strictObject({
      lineNumber: z.number().int().min(1).max(990),
      productCode: z.string().min(1).max(60),
      factor: quantitySchema,
      invoicedQuantity: quantitySchema,
      allocatedQuantity: quantitySchema,
      invoicedValueMinor: minorSchema,
      expectedValueMinor: minorSchema,
      allocations: z.array(
        allocationSchema.extend({
          itemId: uuidSchema,
          orderId: uuidSchema,
          unitPriceMinor: minorSchema,
        }),
      ),
      differences: z.array(fiscalInboundDifferenceSchema),
    }),
  ),
})

export const fiscalInboundReconciliationSchema = z.strictObject({
  id: uuidSchema,
  importId: uuidSchema,
  decision: z.enum(['matched', 'overridden']),
  supplierPartyId: uuidSchema,
  overrideReason: reasonSchema.nullable(),
  comparison: fiscalInboundComparisonSchema,
  comparisonDigest: sha256Schema,
  receipts: z.array(z.strictObject({ receiptId: uuidSchema, orderId: uuidSchema })).min(1),
  payableTitleIds: z.array(uuidSchema),
  reviewedBy: z.string().min(1).max(255),
  reviewedAt: instantSchema,
})

export const fiscalInboundImportSchema = z.strictObject({
  ...fiscalInboundImportSummarySchema.shape,
  verification: fiscalInboundVerificationSchema,
  supplier: z.strictObject({
    taxId: z.string().regex(/^[0-9A-Z]{11,14}$/),
    kind: z.enum(['cnpj', 'cpf']),
    legalName: z.string().min(1).max(60),
    uf: z.string().regex(/^[A-Z]{2}$/),
    candidatePartyIds: z.array(uuidSchema),
  }),
  lines: z.array(invoiceLineSchema).min(1).max(990),
  conflicts: z.array(
    z.strictObject({
      id: uuidSchema,
      sourceDigest: sha256Schema,
      contentDigest: sha256Schema.nullable(),
      receivedAt: instantSchema,
      dismissed: z.boolean(),
      dismissalReason: reasonSchema.nullable(),
    }),
  ),
  proposals: z.array(
    z.strictObject({
      lineNumber: z.number().int().min(1).max(990),
      basis: z.enum(['mapping', 'ncm', 'none']),
      allocations: z.array(allocationSchema),
    }),
  ),
  reconciliation: fiscalInboundReconciliationSchema.nullable(),
  laterChanges: z.array(
    z.strictObject({
      kind: z.enum(['receipt-returned', 'payable-reversed']),
      subjectId: uuidSchema,
      observedAt: instantSchema,
    }),
  ),
})

export const fiscalInboundConflictDismissalRequestSchema = z.strictObject({
  conflictId: uuidSchema,
  reason: reasonSchema,
})

export const fiscalInboundReconciliationRequestSchema = z.strictObject({
  supplierPartyId: uuidSchema,
  lines: z
    .array(allocationSchema.extend({ lineNumber: z.number().int().min(1).max(990) }))
    .max(990),
  unmatchedLines: z.array(z.number().int().min(1).max(990)).max(990),
  /** Buyer units per supplier unit for a line; remembered with the mapping. */
  unitFactors: z
    .array(z.strictObject({ lineNumber: z.number().int().min(1).max(990), factor: quantitySchema }))
    .max(990)
    .optional(),
  rememberMappings: z.boolean(),
  overrideReason: reasonSchema.optional(),
})

export type FiscalInboundImport = z.infer<typeof fiscalInboundImportSchema>
export type FiscalInboundImportSummary = z.infer<typeof fiscalInboundImportSummarySchema>
export type FiscalInboundReconciliation = z.infer<typeof fiscalInboundReconciliationSchema>
export type FiscalInboundReconciliationRequest = z.infer<
  typeof fiscalInboundReconciliationRequestSchema
>
