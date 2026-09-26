import { z } from 'zod'

/** Reviewed mapping of frozen commercial items to NF-e issuance fields. */
export const nfe55IssuanceProfileSchema = z.strictObject({
  capabilityId: z.uuid(),
  issuerAddress: z.strictObject({
    street: z.string().min(2).max(60),
    number: z.string().min(1).max(60),
    complement: z.string().min(1).max(60).nullable(),
    district: z.string().min(2).max(60),
  }),
  /** Reviewed CFOP and nature per linked kind, each bound to its own capability row. */
  linked: z
    .partialRecord(
      z.enum(['sale-return', 'purchase-return', 'value-complement']),
      z.strictObject({
        capabilityId: z.uuid(),
        cfop: z.string().regex(/^[15]\d{3}$/),
        natureOperation: z.string().min(1).max(60),
      }),
    )
    .optional(),
  lineFacts: z.record(
    z.uuid(),
    z.strictObject({
      productCode: z.string().min(1).max(60),
      cfop: z.string().regex(/^5\d{3}$/),
      unit: z.string().min(1).max(6),
      ibsCbsCst: z.string().regex(/^\d{3}$/),
      ibsCbsClassification: z.string().regex(/^\d{6}$/),
    }),
  ),
})

export type Nfe55IssuanceProfile = z.infer<typeof nfe55IssuanceProfileSchema>
