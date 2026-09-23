import { moneySchema, quantitySchema, salesFiscalOriginRecorded } from '@horizon/contracts'
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
export type FiscalOriginSnapshot =
  | ReturnType<typeof salesFiscalOriginRecorded.payload.parse>
  | ManualOriginPayload

export function parseFiscalOriginSnapshot(input: unknown): FiscalOriginSnapshot {
  if (
    input &&
    typeof input === 'object' &&
    'originModule' in input &&
    input.originModule === 'fiscal'
  )
    return manualOriginPayloadSchema.parse(input)
  return salesFiscalOriginRecorded.payload.parse(input)
}
