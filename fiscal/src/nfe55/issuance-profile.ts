import { z } from 'zod'
import { NFCE_PAYMENT_METHODS } from '../nfce65/model'

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
  /** The reviewed NFC-e model 65 facts, bound to its own capability row. */
  consumer: z
    .strictObject({
      capabilityId: z.uuid(),
      natureOperation: z.string().min(1).max(60),
      /** `indPres`: 1 in person, 4 home delivery. */
      presence: z.enum(['1', '4']),
      payment: z.strictObject({
        indicator: z.enum(['0', '1']),
        method: z.enum(NFCE_PAYMENT_METHODS),
      }),
      /** Counted from the authorization protocol; a legal window is part of the review. */
      cancellationWindowMinutes: z.number().int().min(1).max(10_080),
    })
    .optional(),
  /** The reviewed national NFS-e facts, bound to one municipality's capability row. */
  service: z
    .strictObject({
      capabilityId: z.uuid(),
      municipalityCode: z.string().regex(/^\d{7}$/),
      /** Municipal deadlines (E0822, E0050); counted from the NFS-e `dhProc`. */
      cancellationWindowDays: z.number().int().min(1).max(3650),
      substitutionWindowDays: z.number().int().min(1).max(3650),
      /** `cIndOp` (Anexo C). */
      operationIndicator: z.string().regex(/^\d{6}$/),
      ibsCbs: z.strictObject({
        cst: z.string().regex(/^\d{3}$/),
        classification: z.string().regex(/^\d{6}$/),
      }),
    })
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
