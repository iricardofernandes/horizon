import {
  moneySchema,
  quantitySchema,
  salesFiscalOriginFrozen,
  salesFiscalOriginRecorded,
} from '@horizon/contracts'
import { z } from 'zod'

export const manualOriginPayloadSchema = z.strictObject({
  originModule: z.literal('fiscal'),
  originDocumentType: z.literal('manual-simulation'),
  originId: z.uuid(),
  purpose: z.literal('manual'),
  customerId: z.uuid(),
  establishmentId: z.uuid(),
  issueDate: z.iso.date(),
  issuerProfileRevision: z.number().int().positive(),
  recipientProfileRevision: z.number().int().positive(),
  reasonDigest: z.string().regex(/^[0-9a-f]{64}$/),
  lines: z
    .array(
      z.strictObject({
        lineId: z.uuid(),
        itemId: z.uuid(),
        catalogRevision: z.number().int().positive(),
        description: z.string().min(1).max(160),
        quantity: quantitySchema,
        unitPrice: moneySchema,
        lineTotal: moneySchema,
      }),
    )
    .min(1)
    .max(990),
  total: moneySchema,
})

export type ManualOriginPayload = z.infer<typeof manualOriginPayloadSchema>

const accessKeySchema = z.string().regex(/^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$/)

/** A frozen return or complement: owner facts plus the originals it points at. */
export const linkedOriginPayloadSchema = z.strictObject({
  originModule: z.literal('fiscal'),
  originDocumentType: z.literal('linked'),
  originId: z.uuid(),
  purpose: z.literal('linked'),
  kind: z.enum(['sale-return', 'purchase-return', 'value-complement']),
  customerId: z.uuid(),
  establishmentId: z.uuid(),
  source: z.strictObject({
    module: z.enum(['sales', 'procurement', 'fiscal']),
    documentType: z.enum(['shipment', 'receipt', 'review']),
    id: z.uuid(),
  }),
  references: z
    .array(
      z.discriminatedUnion('type', [
        z.strictObject({
          type: z.literal('document'),
          documentId: z.uuid(),
          accessKey: accessKeySchema,
        }),
        z.strictObject({
          type: z.literal('supplier-invoice'),
          importId: z.uuid(),
          accessKey: accessKeySchema,
        }),
      ]),
    )
    .min(1)
    .max(999),
  reasonDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  lines: z
    .array(
      z.strictObject({
        lineId: z.uuid(),
        itemId: z.uuid(),
        description: z.string().min(1).max(160),
        quantity: quantitySchema,
        unitPrice: moneySchema,
        lineTotal: moneySchema,
        references: z
          .array(
            z.strictObject({
              referenceKey: z.string().min(1).max(200),
              referenceQuantity: quantitySchema.nullable(),
              quantity: quantitySchema,
            }),
          )
          .min(1),
      }),
    )
    .min(1)
    .max(990),
  total: moneySchema,
})

export type LinkedOriginPayload = z.infer<typeof linkedOriginPayloadSchema>
export type FiscalOriginSnapshot =
  | ReturnType<typeof salesFiscalOriginRecorded.payload.parse>
  | ReturnType<typeof salesFiscalOriginFrozen.payload.parse>
  | ManualOriginPayload
  | LinkedOriginPayload

export function parseFiscalOriginSnapshot(input: unknown): FiscalOriginSnapshot {
  if (
    input &&
    typeof input === 'object' &&
    'originModule' in input &&
    input.originModule === 'fiscal'
  )
    return 'originDocumentType' in input && input.originDocumentType === 'linked'
      ? linkedOriginPayloadSchema.parse(input)
      : manualOriginPayloadSchema.parse(input)
  if (input && typeof input === 'object' && 'preDispatch' in input)
    return salesFiscalOriginFrozen.payload.parse(input)
  return salesFiscalOriginRecorded.payload.parse(input)
}
