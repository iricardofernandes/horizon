import type { Category, PaymentMethod, PaymentTerm } from '@/features/classifications/types'

export type Direction = 'receivable' | 'payable'

/** Receivables and payables share every screen; their copy lives in one namespace each. */
export function namespaceOf(direction: Direction): 'receivables' | 'payables' {
  return direction === 'receivable' ? 'receivables' : 'payables'
}

export function apiBaseOf(direction: Direction): string {
  return `/api/horizon/financial/${direction}s`
}

/** A receivable is classified as revenue, a payable as expense. */
export function natureOf(direction: Direction): 'revenue' | 'expense' {
  return direction === 'receivable' ? 'revenue' : 'expense'
}

export type ApprovalState = 'none' | 'pending' | 'approved' | 'rejected' | 'not-required'

export type Origin = { type: 'manual' } | { type: 'sales-order'; orderId: string }

export type TitleStatus = 'draft' | 'posted' | 'cancelled' | 'reversed'
export type SettlementState = 'open' | 'partially-settled' | 'settled'

export type TitleRow = {
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
  approvalState: ApprovalState
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

export type TitleDetail = Omit<TitleRow, 'nextDueOn'> & {
  description: string | null
  categoryId: string | null
  competenceOn: string
  installments: Installment[]
  settlements: Settlement[]
  closureReason: string | null
  approvalRequestedBy: string | null
  approvalDecidedBy: string | null
  approvalReason: string | null
  timeline: TimelineEntry[]
}

export const AGING_BUCKETS = ['current', 'days1To30', 'days31To60', 'days61To90', 'over90'] as const

export type TitlesSummary = {
  drafts: number
  awaitingApproval: number
  currencies: {
    currency: string
    outstanding: string
    overdue: string
    dueWithin7Days: string
    aging: Record<(typeof AGING_BUCKETS)[number], string>
  }[]
}

export type Counterparty = { partyId: string; legalName: string }

export type ApprovalPolicy = { currency: string; threshold: string; updatedAt: string }

export type TitlesData = {
  direction: Direction
  titles: TitleRow[]
  summary: TitlesSummary
  counterparties: Counterparty[]
  approvalPolicies: ApprovalPolicy[]
  /** Accounts the cash may move through; empty when the session holds no treasury role. */
  treasuryAccounts: { id: string; name: string; currency: string }[]
  categories: Category[]
  paymentMethods: PaymentMethod[]
  paymentTerms: PaymentTerm[]
}

export const TITLE_VIEWS = [
  'all',
  'draft',
  'awaiting-approval',
  'open',
  'overdue',
  'settled',
  'closed',
] as const
export type TitleView = (typeof TITLE_VIEWS)[number]

/** Only payables wait for approval, so only they offer that view. */
export function viewsOf(direction: Direction): readonly TitleView[] {
  return TITLE_VIEWS.filter((view) => direction === 'payable' || view !== 'awaiting-approval')
}

/** The same partition the API applies to `?view=`, over rows already loaded. */
export function inView(row: TitleRow, view: TitleView): boolean {
  const posted = row.status === 'posted'
  switch (view) {
    case 'draft':
      return row.status === 'draft'
    case 'awaiting-approval':
      return row.status === 'draft' && row.approvalState === 'pending'
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
export function displayStatus(
  row: Pick<TitleRow, 'status' | 'settlementState' | 'overdue'> &
    Partial<Pick<TitleRow, 'approvalState'>>,
) {
  if (row.status === 'draft') return draftStatus(row.approvalState)
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

function draftStatus(approval: ApprovalState | undefined): string {
  if (approval === 'pending') return 'awaiting-approval'
  if (approval === 'approved' || approval === 'rejected') return approval
  return 'draft'
}

/**
 * Whether the workspace policy asks for approval before this payable posts: always without
 * a policy for its currency, otherwise from the threshold up. The server decides again.
 */
export function approvalRequired(
  data: Pick<TitlesData, 'direction' | 'approvalPolicies'>,
  title: Pick<TitleDetail, 'currency' | 'total'>,
): boolean {
  if (data.direction !== 'payable') return false
  const policy = data.approvalPolicies.find((candidate) => candidate.currency === title.currency)
  return !policy || BigInt(title.total) >= BigInt(policy.threshold)
}
