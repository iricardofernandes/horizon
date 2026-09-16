import type { Category, PaymentMethod, PaymentTerm } from '@/features/classifications/types'

export type Origin = { type: 'manual' } | { type: 'sales-order'; orderId: string }

export type TitleStatus = 'draft' | 'posted' | 'cancelled' | 'reversed'
export type SettlementState = 'open' | 'partially-settled' | 'settled'

export type ReceivableRow = {
  id: string
  documentNumber: string
  partyId: string
  partyName: string | null
  origin: Origin
  currency: string
  issuedOn: string
  nextDueOn: string | null
  status: TitleStatus
  settlementState: SettlementState
  overdue: boolean
  total: string
  outstanding: string
}

export type Installment = {
  number: number
  dueOn: string
  amount: string
  outstanding: string
  state: SettlementState
}

export type Settlement = {
  id: string
  installmentNumber: number
  settledOn: string
  received: string
  discount: string
  interest: string
  penalty: string
  paymentMethodId: string | null
  recordedAt: string
  reversedAt: string | null
  reversalReason: string | null
}

export type TimelineEntry = {
  sequence: number
  action: string
  actor: string
  occurredAt: string
}

export type ReceivableDetail = Omit<ReceivableRow, 'nextDueOn'> & {
  description: string | null
  categoryId: string | null
  competenceOn: string
  installments: Installment[]
  settlements: Settlement[]
  closureReason: string | null
  timeline: TimelineEntry[]
}

export const AGING_BUCKETS = ['current', 'days1To30', 'days31To60', 'days61To90', 'over90'] as const

export type ReceivablesSummary = {
  drafts: number
  currencies: {
    currency: string
    outstanding: string
    overdue: string
    dueWithin7Days: string
    aging: Record<(typeof AGING_BUCKETS)[number], string>
  }[]
}

export type Customer = { partyId: string; legalName: string }

export type ReceivablesData = {
  receivables: ReceivableRow[]
  summary: ReceivablesSummary
  customers: Customer[]
  categories: Category[]
  paymentMethods: PaymentMethod[]
  paymentTerms: PaymentTerm[]
}

export const RECEIVABLE_VIEWS = ['all', 'draft', 'open', 'overdue', 'settled', 'closed'] as const
export type ReceivableView = (typeof RECEIVABLE_VIEWS)[number]

/** The same partition the API applies to `?view=`, over rows already loaded. */
export function inView(row: ReceivableRow, view: ReceivableView): boolean {
  const posted = row.status === 'posted'
  switch (view) {
    case 'draft':
      return row.status === 'draft'
    case 'open':
      return posted && row.settlementState !== 'settled'
    case 'overdue':
      return posted && row.overdue
    case 'settled':
      return posted && row.settlementState === 'settled'
    case 'closed':
      return row.status === 'cancelled' || row.status === 'reversed'
    default:
      return true
  }
}

/** What a reader calls the state of a title: its lifecycle, or how much of it was collected. */
export function displayStatus(row: Pick<ReceivableRow, 'status' | 'settlementState' | 'overdue'>) {
  if (row.status !== 'posted') return row.status
  if (row.settlementState === 'settled') return 'settled'
  return row.overdue ? 'overdue' : row.settlementState
}

/** The browser's calendar date: what is overdue depends on where "today" is (ADR 0043). */
export function localToday(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** Minor units back to the decimal text an input shows: "12345" → "123.45". */
export function decimalOf(amount: string): string {
  const padded = amount.padStart(3, '0')
  return `${padded.slice(0, -2)}.${padded.slice(-2)}`
}

export function plusDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

/**
 * Split an amount across a payment term the way Financial does: each installment gets its
 * floor, and the leftover minor units go to the largest remainders, earliest first.
 */
export function scheduleOf(
  total: bigint,
  issuedOn: string,
  term: Pick<PaymentTerm, 'installments'>,
): { dueOn: string; amount: string }[] {
  const exact = term.installments.map((rule) => total * BigInt(rule.basisPoints))
  const parts = exact.map((value) => value / 10_000n)
  let leftover = total - parts.reduce((sum, value) => sum + value, 0n)
  const order = exact
    .map((value, index) => ({ index, remainder: value % 10_000n }))
    .sort((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
    )
  for (const { index } of order) {
    if (leftover === 0n) break
    parts[index] = (parts[index] ?? 0n) + 1n
    leftover -= 1n
  }
  return term.installments.map((rule, index) => ({
    dueOn: plusDays(issuedOn, rule.dueInDays),
    amount: String(parts[index] ?? 0n),
  }))
}
