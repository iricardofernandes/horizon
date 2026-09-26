import { z } from 'zod'
import { buildDpsId } from './identifiers'
import {
  ibgeMunicipality,
  isOperationIndicator,
  nationalServiceDescription,
  nbsDescription,
} from './reference'

/** `TSString`: no leading or trailing blank and printable Latin-1 characters. */
const text = (minimum: number, maximum: number) =>
  z
    .string()
    .trim()
    .min(minimum)
    .max(maximum)
    .regex(/^[!-ÿ](?:[ -ÿ]*[!-ÿ])?$/, 'must be printable Latin-1 text')
/** `TSDec15V2`. */
const amount = z.string().regex(/^(?:0|0\.\d{2}|[1-9]\d{0,14}(?:\.\d{2})?)$/)
const municipalityCode = z
  .string()
  .regex(/^\d{7}$/)
  .refine((code) => ibgeMunicipality(code) !== null, 'is not an IBGE municipality (Anexo A)')
/** `TSDateTimeUTC`: seconds and a whole-hour offset. */
const dateTime = z.string().regex(/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:00$/)

const addressSchema = z.strictObject({
  municipalityCode,
  postalCode: z.string().regex(/^\d{8}$/),
  street: text(1, 255),
  number: text(1, 60),
  complement: text(1, 156).nullable(),
  district: text(1, 60),
})

/**
 * The frozen facts of one DPS (layout 1.01) for a provider that is not in the Simples
 * Nacional, issuing a taxable service with no withholding, deduction or benefit.
 */
export const nfseDpsDataSchema = z
  .strictObject({
    dpsId: z.string().regex(/^DPS\d{42}$/),
    /** `tpAmb` 2: a simulated or test document never has fiscal value. */
    environment: z.literal('2'),
    issuedAt: dateTime,
    applicationVersion: text(1, 20),
    series: z.number().int().min(1).max(49_999),
    number: z.number().int().min(1).max(999_999_999_999_999),
    competenceDate: z.iso.date(),
    issuingMunicipality: municipalityCode,
    provider: z.strictObject({
      cnpj: z.string().regex(/^\d{14}$/),
      municipalRegistration: text(1, 15).nullable(),
      /** `opSimpNac` 1: not a Simples Nacional taxpayer; `regEspTrib` 0: no special regime. */
      simplesOption: z.literal('1'),
      specialRegime: z.literal('0'),
    }),
    recipient: z.strictObject({
      kind: z.enum(['cpf', 'cnpj']),
      taxId: z.string().regex(/^\d{11}$|^\d{14}$/),
      name: text(1, 300),
      address: addressSchema,
    }),
    service: z.strictObject({
      placeMunicipality: municipalityCode,
      nationalTaxCode: z
        .string()
        .regex(/^\d{6}$/)
        .refine((code) => nationalServiceDescription(code) !== null, 'is not in the national list'),
      municipalTaxCode: z.string().min(1).max(20).nullable(),
      description: text(1, 2000),
      nbsCode: z
        .string()
        .regex(/^\d{9}$/)
        .refine((code) => nbsDescription(code) !== null, 'is not an NBS 2.0 code'),
    }),
    values: z.strictObject({
      serviceAmount: amount,
      /** `tribISSQN` 1 (taxable) and `tpRetISSQN` 1 (not withheld). */
      issTaxation: z.literal('1'),
      withholding: z.literal('1'),
    }),
    substitution: z
      .strictObject({
        replacedKey: z.string().regex(/^\d{50}$/),
        reasonCode: z.enum(['01', '02', '03', '04', '05', '99']),
        reason: text(15, 255).nullable(),
      })
      .nullable(),
    ibsCbs: z.strictObject({
      purpose: z.literal('0'),
      operationIndicator: z
        .string()
        .regex(/^\d{6}$/)
        .refine(isOperationIndicator, 'is not an operation indicator (Anexo C)'),
      destination: z.literal('0'),
      cst: z.string().regex(/^\d{3}$/),
      classification: z.string().regex(/^\d{6}$/),
    }),
  })
  .superRefine((value, context) => {
    const expected = buildDpsId({
      municipalityCode: value.issuingMunicipality,
      cnpj: value.provider.cnpj,
      series: value.series,
      number: value.number,
    })
    if (value.dpsId !== expected)
      context.addIssue({
        code: 'custom',
        path: ['dpsId'],
        message: 'differs from its facts (E0004)',
      })
    if (value.recipient.taxId.length !== (value.recipient.kind === 'cpf' ? 11 : 14))
      context.addIssue({ code: 'custom', path: ['recipient', 'taxId'], message: 'wrong length' })
    if (value.competenceDate > value.issuedAt.slice(0, 10))
      context.addIssue({
        code: 'custom',
        path: ['competenceDate'],
        message: 'is after the emission date (E0015)',
      })
    if (value.substitution?.reasonCode === '99' && !value.substitution.reason)
      context.addIssue({
        code: 'custom',
        path: ['substitution', 'reason'],
        message: 'is required for reason 99 (E0078)',
      })
  })

export type NfseDpsData = z.infer<typeof nfseDpsDataSchema>
