import { z } from 'zod'

import { dateSchema, instantSchema, moneySchema, quantitySchema, uuidSchema } from '../common'

/**
 * Tax estimates (Phase 87, ADR 0073): Fiscal's calculation of a commercial draft, never
 * locked. Sales and Procurement keep the summary, labeled as an estimate; only a Fiscal lock
 * reaches Financial and Ledger as tax amounts.
 */

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/)
const componentCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/)
const factsSchema = z.record(
  z.string().regex(/^[a-z][A-Za-z0-9]{0,39}$/),
  z.string().min(1).max(80),
)

const estimateLineSchema = z.object({
  itemId: uuidSchema,
  quantity: quantitySchema,
  /** Minor units per unit, as the order line keeps it. */
  unitPrice: moneySchema,
  discount: moneySchema.optional(),
  /** Facts only the caller knows, such as what a contributor does with the goods. */
  facts: factsSchema.optional(),
  classTrib: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
})

export const fiscalTaxEstimateRequestSchema = z.discriminatedUnion('direction', [
  /** The workspace sells to a customer: derived as readiness derives a shipment's input. */
  z.object({
    direction: z.literal('sale'),
    establishmentId: uuidSchema,
    customerPartyId: uuidSchema,
    issueDate: dateSchema,
    lines: z.array(estimateLineSchema).min(1).max(200),
  }),
  /**
   * The workspace buys from a supplier. Fiscal holds no supplier regime, so the caller
   * states it; Fiscal never infers a treatment it was not given.
   */
  z.object({
    direction: z.literal('purchase'),
    establishmentId: uuidSchema,
    supplierPartyId: uuidSchema,
    supplier: z.object({
      regime: z.enum(['normal', 'simples-nacional', 'mei']),
      incomeTaxRegime: z.enum(['lucro-real', 'lucro-presumido']).optional(),
    }),
    issueDate: dateSchema,
    lines: z.array(estimateLineSchema).min(1).max(200),
  }),
])

export const fiscalTaxComponentSummarySchema = z.object({
  group: z.enum(['legacy', 'ibsCbs']),
  code: componentCodeSchema,
  amount: moneySchema,
  outcome: z.enum(['levied', 'exempt', 'suspended', 'deferred', 'not-levied']),
})

/** Components charged on top of the price (IPI, ICMS-ST, FCP-ST); the rest are inside it. */
export const FISCAL_TAXES_CHARGED_ON_TOP = ['IPI', 'ICMS_ST', 'FCP_ST'] as const

const supportedEstimateSchema = z.object({
  schemaVersion: z.literal(1),
  supported: z.literal(true),
  estimatedAt: instantSchema,
  components: z.array(fiscalTaxComponentSummarySchema).max(64),
  totals: z.object({
    net: moneySchema,
    /** Every levied component, inside the price or on top of it. */
    tax: moneySchema,
    /** What the buyer is charged beyond the price: the taxes charged on top. */
    chargedOnTop: moneySchema,
    /** The net plus what is charged on top. */
    gross: moneySchema,
  }),
  inputDigest: digestSchema,
  rulesDigest: digestSchema,
  resultDigest: digestSchema,
})

export const fiscalTaxEstimateSchema = z.discriminatedUnion('supported', [
  supportedEstimateSchema,
  z.object({
    schemaVersion: z.literal(1),
    supported: z.literal(false),
    estimatedAt: instantSchema,
    code: z.string().min(1).max(60),
    detail: z.string().min(1).max(500),
    missingDimension: z.string().min(1).max(200).optional(),
  }),
])

/**
 * An estimate Fiscal issued, as it returns it by its result digest (Phase 91): the request it
 * answered, and what it answered. Sales and Procurement keep an estimate only once Fiscal has
 * returned it, and only when the request is their document's.
 */
export const fiscalTaxEstimateRecordSchema = z.object({
  request: fiscalTaxEstimateRequestSchema,
  estimate: supportedEstimateSchema,
})

/** What the web sends Sales or Procurement to keep an estimate: its digest, never its body. */
export const fiscalTaxEstimateReferenceSchema = z.strictObject({ resultDigest: digestSchema })

/** A Sales or Procurement document, as far as an estimate of it can be checked. */
export interface EstimatedDocument {
  readonly direction: 'sale' | 'purchase'
  readonly partyId: string
  readonly lines: readonly {
    readonly itemId: string
    readonly quantity: string
    readonly unitPrice: { readonly amount: string; readonly currency: string }
    readonly discount?: { readonly amount: string; readonly currency: string } | undefined
  }[]
}

/**
 * Whether Fiscal was asked about this very document: its direction, its party, and the same
 * lines in any order, each with its item, quantity, unit price and discount. Quantities
 * compare as numbers, so `2` and `2.000` are one, and a zero discount is no discount.
 */
export function estimateRequestMatches(
  request: FiscalTaxEstimateRequest,
  document: EstimatedDocument,
): boolean {
  if (request.direction !== document.direction) return false
  const partyId = request.direction === 'sale' ? request.customerPartyId : request.supplierPartyId
  if (partyId !== document.partyId) return false
  const keyOf = (line: EstimatedDocument['lines'][number]) =>
    [
      line.itemId,
      canonicalQuantity(line.quantity),
      `${BigInt(line.unitPrice.amount)} ${line.unitPrice.currency}`,
      line.discount && BigInt(line.discount.amount) !== 0n
        ? `${BigInt(line.discount.amount)} ${line.discount.currency}`
        : 'no discount',
    ].join('|')
  const asked = request.lines.map(keyOf).sort()
  const held = document.lines.map(keyOf).sort()
  return asked.length === held.length && asked.every((key, index) => key === held[index])
}

function canonicalQuantity(quantity: string): string {
  const [whole = '0', fraction = ''] = quantity.split('.')
  const digits = whole.replace(/^0+(?=\d)/, '')
  const decimals = fraction.replace(/0+$/, '')
  return decimals ? `${digits}.${decimals}` : digits
}

/** What a Sales or Procurement record keeps of an estimate: components, amounts, digests. */
export const fiscalTaxEstimateDigestSchema = z.object({
  components: z.array(fiscalTaxComponentSummarySchema.pick({ code: true, amount: true })).max(64),
  chargedOnTop: moneySchema,
  inputDigest: digestSchema,
  rulesDigest: digestSchema,
  resultDigest: digestSchema,
})

export type FiscalTaxEstimateRequest = z.infer<typeof fiscalTaxEstimateRequestSchema>
export type FiscalTaxEstimate = z.infer<typeof fiscalTaxEstimateSchema>
export type FiscalTaxComponentSummary = z.infer<typeof fiscalTaxComponentSummarySchema>
export type FiscalTaxEstimateDigest = z.infer<typeof fiscalTaxEstimateDigestSchema>
export type FiscalTaxEstimateRecord = z.infer<typeof fiscalTaxEstimateRecordSchema>
export type FiscalTaxEstimateReference = z.infer<typeof fiscalTaxEstimateReferenceSchema>
