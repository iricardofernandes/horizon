import { z } from 'zod'
import { isValidNfeAccessKey } from './access-key'

const text = (minimum: number, maximum: number) => z.string().trim().min(minimum).max(maximum)
const taxId = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase().replace(/[.\-/\s]/g, ''))
  .pipe(z.string().regex(/^[0-9A-Z]{12}[0-9]{2}$/))
const decimal2 = z.string().regex(/^(?:0|[1-9]\d{0,12})\.\d{2}$/)
const decimal4 = z.string().regex(/^(?:0|[1-9]\d{0,10})(?:\.\d{1,4})?$/)
const rate = z.string().regex(/^(?:0|[1-9]\d{0,2})\.\d{2,4}$/)

const addressSchema = z.strictObject({
  street: text(2, 60),
  number: text(1, 60),
  complement: text(1, 60).nullable().default(null),
  district: text(2, 60),
  municipalityCode: z.string().regex(/^\d{7}$/),
  city: text(2, 60),
  state: z.string().regex(/^[A-Z]{2}$/),
  postalCode: z.string().regex(/^\d{8}$/),
})

const partySchema = z.strictObject({
  taxId,
  legalName: text(2, 60),
  stateRegistration: text(2, 14),
  address: addressSchema,
})

const lineSchema = z.strictObject({
  number: z.number().int().min(1).max(990),
  productCode: text(1, 60),
  description: text(1, 120),
  ncm: z.string().regex(/^\d{8}$/),
  cfop: z.string().regex(/^[123567]\d{3}$/),
  unit: text(1, 6),
  quantity: decimal4,
  unitPrice: z.string().regex(/^(?:0|[1-9]\d{0,10})(?:\.\d{1,10})?$/),
  gross: decimal2,
  discount: decimal2.default('0.00'),
  other: decimal2.default('0.00'),
  ibsCbs: z.strictObject({
    cst: z.string().regex(/^\d{3}$/),
    classification: z.string().regex(/^\d{6}$/),
    base: decimal2,
    ibsUfRate: rate,
    ibsUfValue: decimal2,
    ibsMunicipalRate: rate,
    ibsMunicipalValue: decimal2,
    cbsRate: rate,
    cbsValue: decimal2,
  }),
})

export const nfe55DataSchema = z
  .strictObject({
    accessKey: z.string().refine(isValidNfeAccessKey, 'invalid NF-e access key'),
    issuedAt: z.iso.datetime({ offset: true }),
    natureOperation: text(1, 60),
    numericCode: z.string().regex(/^\d{8}$/),
    series: z.number().int().min(0).max(999),
    number: z.number().int().min(1).max(999_999_999),
    issuer: partySchema,
    recipient: partySchema,
    lines: z.array(lineSchema).min(1).max(990),
    totals: z.strictObject({
      products: decimal2,
      discounts: decimal2,
      other: decimal2,
      invoice: decimal2,
      ibsUf: decimal2,
      ibsMunicipal: decimal2,
      ibs: decimal2,
      cbs: decimal2,
      ibsCbsBase: decimal2,
      invoiceWithIbsCbs: decimal2,
    }),
  })
  .superRefine((value, context) => {
    if (value.accessKey.slice(20, 22) !== '55')
      context.addIssue({ code: 'custom', path: ['accessKey'], message: 'must identify model 55' })
    if (Number(value.accessKey.slice(22, 25)) !== value.series)
      context.addIssue({ code: 'custom', path: ['series'], message: 'does not match access key' })
    if (Number(value.accessKey.slice(25, 34)) !== value.number)
      context.addIssue({ code: 'custom', path: ['number'], message: 'does not match access key' })
    if (value.accessKey.slice(6, 20) !== value.issuer.taxId)
      context.addIssue({ code: 'custom', path: ['issuer', 'taxId'], message: 'does not match key' })
    if (
      `${value.issuedAt.slice(2, 4)}${value.issuedAt.slice(5, 7)}` !== value.accessKey.slice(2, 6)
    )
      context.addIssue({ code: 'custom', path: ['issuedAt'], message: 'does not match access key' })
    if (value.accessKey.slice(35, 43) !== value.numericCode)
      context.addIssue({
        code: 'custom',
        path: ['numericCode'],
        message: 'does not match access key',
      })
    const numbers = value.lines.map((line) => line.number)
    if (new Set(numbers).size !== numbers.length)
      context.addIssue({ code: 'custom', path: ['lines'], message: 'line numbers must be unique' })
    reconcile(value, context)
  })

export type Nfe55Data = z.infer<typeof nfe55DataSchema>

function reconcile(value: z.infer<typeof nfe55DataSchema>, context: z.RefinementCtx): void {
  const sum = (members: string[]) => members.reduce((total, member) => total + cents(member), 0n)
  const checks: Array<[path: string, actual: string, expected: bigint]> = [
    ['products', value.totals.products, sum(value.lines.map((line) => line.gross))],
    ['discounts', value.totals.discounts, sum(value.lines.map((line) => line.discount))],
    ['other', value.totals.other, sum(value.lines.map((line) => line.other))],
    ['ibsUf', value.totals.ibsUf, sum(value.lines.map((line) => line.ibsCbs.ibsUfValue))],
    [
      'ibsMunicipal',
      value.totals.ibsMunicipal,
      sum(value.lines.map((line) => line.ibsCbs.ibsMunicipalValue)),
    ],
    ['cbs', value.totals.cbs, sum(value.lines.map((line) => line.ibsCbs.cbsValue))],
    ['ibsCbsBase', value.totals.ibsCbsBase, sum(value.lines.map((line) => line.ibsCbs.base))],
  ]
  const products = cents(value.totals.products)
  const discounts = cents(value.totals.discounts)
  const other = cents(value.totals.other)
  const ibs = cents(value.totals.ibsUf) + cents(value.totals.ibsMunicipal)
  checks.push(
    ['invoice', value.totals.invoice, products - discounts + other],
    ['ibs', value.totals.ibs, ibs],
    [
      'invoiceWithIbsCbs',
      value.totals.invoiceWithIbsCbs,
      cents(value.totals.invoice) + ibs + cents(value.totals.cbs),
    ],
  )
  for (const [path, actual, expected] of checks)
    if (cents(actual) !== expected)
      context.addIssue({
        code: 'custom',
        path: ['totals', path],
        message: 'does not reconcile with frozen lines',
      })
}

function cents(value: string): bigint {
  return BigInt(value.replace('.', ''))
}
