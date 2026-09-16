export type Category = {
  id: string
  code: string
  name: string
  nature: 'revenue' | 'expense'
  parentId: string | null
  depth: number
  active: boolean
}

export type Dimension = {
  id: string
  kind: 'department' | 'project'
  code: string
  name: string
  active: boolean
}

export const PAYMENT_METHOD_KINDS = [
  'cash',
  'bank-transfer',
  'pix',
  'boleto',
  'credit-card',
  'debit-card',
  'check',
  'other',
] as const

export type PaymentMethod = {
  id: string
  kind: (typeof PAYMENT_METHOD_KINDS)[number]
  code: string
  name: string
  active: boolean
}

export type PaymentTerm = {
  id: string
  name: string
  installments: { dueInDays: number; basisPoints: number }[]
  active: boolean
}

export type Registry = 'categories' | 'dimensions' | 'payment-methods' | 'payment-terms'

export type Classifications = {
  categories: Category[]
  dimensions: Dimension[]
  paymentMethods: PaymentMethod[]
  paymentTerms: PaymentTerm[]
}

/** Basis points as a percentage a person reads: 3334 → "33.34". */
export function percentageOf(basisPoints: number): string {
  const fraction = String(basisPoints % 100).padStart(2, '0')
  return `${Math.trunc(basisPoints / 100)}${fraction === '00' ? '' : `.${fraction.replace(/0$/, '')}`}`
}

/** "33.34" → 3334, or null when the text is not a percentage with up to two decimals. */
export function basisPointsOf(percentage: string): number | null {
  const match = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(percentage.trim())
  if (!match?.[1]) return null
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
}
