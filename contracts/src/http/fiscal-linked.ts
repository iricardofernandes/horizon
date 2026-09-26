import { z } from 'zod'

import { instantSchema, moneySchema, quantitySchema, uuidSchema } from '../common'

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)
const reasonSchema = z.string().trim().min(10).max(1000)

/** Every document kind Horizon knows about, supported or not. */
export const fiscalDocumentKindSchema = z.enum([
  'sale',
  'sale-return',
  'purchase-return',
  'value-complement',
  'remittance',
  'remittance-return',
  'quantity-complement',
  'tax-complement',
  'adjustment',
  'credit-note',
  'debit-note',
  'consumer-sale',
  'counter-sale',
  'consumer-sale-offline',
])

/** The kinds a linked origin can be created for. */
export const fiscalLinkedKindSchema = z.enum(['sale-return', 'purchase-return', 'value-complement'])

const ownerSchema = z.strictObject({
  module: z.enum(['inventory', 'financial', 'none']),
  sourceEvent: z.string().min(1).max(80).nullable(),
})

export const fiscalDocumentKindEntrySchema = z.strictObject({
  kind: fiscalDocumentKindSchema,
  model: z.literal('55'),
  supported: z.boolean(),
  purpose: z.enum(['1', '2', '3', '4', '5', '6']),
  direction: z.enum(['inbound', 'outbound']).nullable(),
  operation: z.string().min(1).max(80).nullable(),
  reference: z.enum(['none', 'sale-document', 'supplier-invoice']),
  source: z.string().min(1).max(120).nullable(),
  stockOwner: ownerSchema,
  moneyOwner: ownerSchema,
  reason: z.string().min(1).max(500).nullable(),
})

export const fiscalDocumentKindCatalogueSchema = z.strictObject({
  kinds: z.array(fiscalDocumentKindEntrySchema),
  eventFlows: z.array(
    z.strictObject({
      model: z.enum(['55', '65', 'nfse']),
      flows: z.array(z.enum(['cancellation', 'correction-letter'])),
    }),
  ),
})

/** Version 2 catalogues the kinds of every model, NFC-e 65 included. */
export const fiscalDocumentKindEntryV2Schema = fiscalDocumentKindEntrySchema.extend({
  model: z.enum(['55', '65']),
})

export const fiscalDocumentKindCatalogueV2Schema = fiscalDocumentKindCatalogueSchema.extend({
  kinds: z.array(fiscalDocumentKindEntryV2Schema),
})

export const fiscalLinkedOriginRequestSchema = z.discriminatedUnion('kind', [
  /** The returned Sales shipment; Fiscal finds its return origin and its sale document. */
  z.strictObject({ kind: z.literal('sale-return'), shipmentId: uuidSchema }),
  z.strictObject({
    kind: z.literal('purchase-return'),
    receiptId: uuidSchema,
    /** The establishment that sends the goods back and issues the document. */
    establishmentId: uuidSchema,
  }),
  z.strictObject({
    kind: z.literal('value-complement'),
    referencedDocumentId: uuidSchema,
    reason: reasonSchema,
    lines: z
      .array(z.strictObject({ lineId: uuidSchema, amount: moneySchema }))
      .min(1)
      .max(990),
  }),
])

export const fiscalLinkedOriginSchema = z.strictObject({
  id: uuidSchema,
  kind: fiscalLinkedKindSchema,
  digest: sha256Schema,
  createdAt: instantSchema,
  existing: z.boolean(),
})

export const fiscalLinkedProblemCodeSchema = z.enum([
  'KIND_UNSUPPORTED',
  'SOURCE_NOT_PROJECTED',
  'REFERENCE_NOT_AUTHORIZED',
  'REFERENCE_INCOMPLETE',
  'QUANTITY_EXCEEDED',
  'LINKED_ORIGIN_CONFLICT',
])

/** Stable codes for model 65 refusals. */
export const fiscalConsumerProblemCodeSchema = z.enum([
  'MODEL_CONFLICT',
  'CONSUMER_NOT_ELIGIBLE',
  'CANCELLATION_WINDOW_ELAPSED',
  'READINESS_STALE',
])

const correlationSchema = z.strictObject({
  module: z.enum(['inventory', 'financial']),
  sourceEvent: z.string().min(1).max(80),
  correlationId: uuidSchema,
  observedIds: z.array(uuidSchema),
})

const linkedLineSchema = z.strictObject({
  lineId: uuidSchema,
  itemId: uuidSchema,
  referenceKey: z.string().min(1).max(200),
  referenceQuantity: quantitySchema.nullable(),
  quantity: quantitySchema,
  amount: moneySchema,
})

const linkedDocumentSchema = z.strictObject({
  linkedOriginId: uuidSchema,
  kind: fiscalLinkedKindSchema,
  documentId: uuidSchema.nullable(),
  status: z.string().min(1).max(40).nullable(),
  void: z.boolean(),
  lines: z.array(linkedLineSchema),
})

/** What a document references, what references it, and who owns the effects. */
export const fiscalDocumentLinksSchema = z.strictObject({
  documentId: uuidSchema,
  kind: fiscalDocumentKindSchema,
  references: z.array(
    z.discriminatedUnion('type', [
      z.strictObject({ type: z.literal('document'), documentId: uuidSchema }),
      z.strictObject({ type: z.literal('supplier-invoice'), importId: uuidSchema }),
    ]),
  ),
  linked: z.array(linkedDocumentSchema),
  correlations: z.array(correlationSchema),
  digest: sha256Schema,
})

export const fiscalCorrectionLetterRequestSchema = z.strictObject({
  text: z.string().trim().min(15).max(1000),
  attestation: z.literal(true),
})

export const fiscalCorrectionLetterStatusSchema = z.enum([
  'pending',
  'unknown',
  'registered',
  'rejected',
])

export const fiscalCorrectionLetterSchema = z.strictObject({
  id: uuidSchema,
  documentId: uuidSchema,
  sequence: z.number().int().min(1).max(20),
  status: fiscalCorrectionLetterStatusSchema,
  textDigest: sha256Schema,
  eventXmlDigest: sha256Schema,
  protocolDigest: sha256Schema.nullable(),
  simulated: z.literal(true),
  requestedBy: z.string().min(1).max(200),
  requestedAt: instantSchema,
})

export const fiscalCorrectionLetterListSchema = z.strictObject({
  documentId: uuidSchema,
  letters: z.array(fiscalCorrectionLetterSchema),
})

export type FiscalDocumentKind = z.infer<typeof fiscalDocumentKindSchema>
export type FiscalLinkedKind = z.infer<typeof fiscalLinkedKindSchema>
export type FiscalDocumentKindEntry = z.infer<typeof fiscalDocumentKindEntryV2Schema>
export type FiscalLinkedOriginRequest = z.infer<typeof fiscalLinkedOriginRequestSchema>
export type FiscalDocumentLinks = z.infer<typeof fiscalDocumentLinksSchema>
export type FiscalCorrectionLetter = z.infer<typeof fiscalCorrectionLetterSchema>
export type FiscalLinkedProblemCode = z.infer<typeof fiscalLinkedProblemCodeSchema>
export type FiscalConsumerProblemCode = z.infer<typeof fiscalConsumerProblemCodeSchema>
