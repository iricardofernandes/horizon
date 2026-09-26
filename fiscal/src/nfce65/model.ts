import { z } from 'zod'
import { isValidNfeAccessKey } from '../nfe55/access-key'
import {
  addressSchema,
  cents,
  lineSchema,
  partySchema,
  reconcile,
  text,
  totalsSchema,
} from '../nfe55/model'

/** Only methods that need no card group (NT 2025.001 YA04-10) and carry a value. */
export const NFCE_PAYMENT_METHODS = ['01', '02', '05', '15', '16', '18'] as const

const consumerSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('cpf'),
    taxId: z.string().regex(/^\d{11}$/),
    name: text(2, 60),
    address: addressSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal('cnpj'),
    taxId: z.string().regex(/^[0-9A-Z]{12}[0-9]{2}$/),
    name: text(2, 60),
    address: addressSchema.nullable(),
  }),
])

/**
 * The frozen facts of one NFC-e model 65. It shares the item, issuer and totals groups
 * with model 55 but has its own consumer, presence, payment and supplementary rules.
 */
export const nfce65DataSchema = z
  .strictObject({
    accessKey: z.string().refine(isValidNfeAccessKey, 'invalid NFC-e access key'),
    issuedAt: z.iso.datetime({ offset: true }),
    natureOperation: text(1, 60),
    numericCode: z.string().regex(/^\d{8}$/),
    processVersion: text(1, 20),
    series: z.number().int().min(0).max(999),
    number: z.number().int().min(1).max(999_999_999),
    /** `tpAmb`: simulation documents are marked 2 and never have fiscal value. */
    environment: z.literal('2'),
    /** `indPres`: 1 in person, 4 home delivery. */
    presence: z.enum(['1', '4']),
    issuer: partySchema,
    /** Null prints "CONSUMIDOR NÃO IDENTIFICADO". */
    consumer: consumerSchema.nullable(),
    lines: z.array(lineSchema).min(1).max(990),
    totals: totalsSchema,
    payment: z.strictObject({
      /** `indPag`: 0 paid now, 1 on account. */
      indicator: z.enum(['0', '1']),
      method: z.enum(NFCE_PAYMENT_METHODS),
      amount: z.string().regex(/^(?:0|[1-9]\d{0,12})\.\d{2}$/),
    }),
    supplement: z.strictObject({
      qrCode: z.string().min(60).max(1000),
      keyQueryUrl: z.string().min(21).max(85),
    }),
  })
  .superRefine((value, context) => {
    const issue = (path: (string | number)[], message: string) =>
      context.addIssue({ code: 'custom', path, message })
    if (value.accessKey.slice(20, 22) !== '65') issue(['accessKey'], 'must identify model 65')
    if (Number(value.accessKey.slice(22, 25)) !== value.series)
      issue(['series'], 'does not match access key')
    if (Number(value.accessKey.slice(25, 34)) !== value.number)
      issue(['number'], 'does not match access key')
    if (value.accessKey.slice(6, 20) !== value.issuer.taxId)
      issue(['issuer', 'taxId'], 'does not match key')
    if (value.accessKey[34] !== '1') issue(['accessKey'], 'only online emission (tpEmis 1)')
    if (
      `${value.issuedAt.slice(2, 4)}${value.issuedAt.slice(5, 7)}` !== value.accessKey.slice(2, 6)
    )
      issue(['issuedAt'], 'does not match access key')
    if (value.accessKey.slice(35, 43) !== value.numericCode)
      issue(['numericCode'], 'does not match access key')
    if (value.presence === '4' && !value.consumer?.address)
      issue(['consumer'], 'a home delivery identifies the consumer and the delivery address')
    for (const [index, line] of value.lines.entries())
      if (!line.cfop.startsWith('5'))
        issue(['lines', index, 'cfop'], 'an NFC-e is an intrastate outbound sale')
    const numbers = value.lines.map((line) => line.number)
    if (new Set(numbers).size !== numbers.length) issue(['lines'], 'line numbers must be unique')
    if (cents(value.payment.amount) !== cents(value.totals.invoice))
      issue(['payment', 'amount'], 'must equal the invoice total')
    if (!value.supplement.qrCode.endsWith(`?p=${value.accessKey}|3|${value.environment}`))
      issue(['supplement', 'qrCode'], 'must be the version 3 online QR code of this key')
    reconcile(value, context)
  })

export type Nfce65Data = z.infer<typeof nfce65DataSchema>
export type Nfce65DataInput = z.input<typeof nfce65DataSchema>
