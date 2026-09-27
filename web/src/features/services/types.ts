import { reference } from '@/features/sales/types'

export { SALES_API } from '@/features/sales/types'

export const SERVICE_ORDER_STATUSES = [
  'scheduled',
  'in_progress',
  'completed',
  'accepted',
  'cancelled',
] as const
export type ServiceOrderStatus = (typeof SERVICE_ORDER_STATUSES)[number]

/** Work still moving; a cancelled order is history, not a column (as on the sales boards). */
export const SERVICE_ORDER_COLUMNS: readonly ServiceOrderStatus[] = [
  'scheduled',
  'in_progress',
  'completed',
  'accepted',
]

export type NfseEffect = {
  documentId: string | null
  status: 'authorized' | 'rejected' | 'cancelled' | null
}

export type ReceivableEffect = {
  titleId: string | null
  postedAt: string | null
  reversedAt: string | null
}

export type ServiceOrderLine = {
  lineId: string
  itemId: string
  description: string
  quantity: string
  delivered: string
  unitPrice: string
  lineTotal: string
}

export type ServiceDelivery = {
  id: string
  performedOn: string
  competence: string
  value: string
  status: 'active' | 'cancelled'
  deliveredBy: string
  cancelledBy: string | null
  cancelledOn: string | null
  cancellationReason: string | null
  createdAt: string
  /** Only in the detail read (Phase 53): what Financial did with it. */
  receivable?: ReceivableEffect
  entries: Array<{
    entryId: string
    lineId: string
    description: string
    quantity: string
    amount: string
    /** Only in the detail read (Phase 53): what Fiscal did with this line. */
    nfse?: NfseEffect
  }>
}

export type ServiceOrder = {
  id: string
  customerId: string
  quoteId: string | null
  status: ServiceOrderStatus
  currency: string
  net: string
  discount: string
  total: string
  billed: string
  paymentTermDays: number[]
  notes: string | null
  scheduledFor: string | null
  openedOn: string
  createdBy: string
  acceptedBy: string | null
  closureReason: string | null
  createdAt: string
  lines: ServiceOrderLine[]
  deliveries: ServiceDelivery[]
}

export const RECURRENCES = ['monthly', 'quarterly', 'yearly'] as const
export type Recurrence = (typeof RECURRENCES)[number]
export type ContractStatus = 'draft' | 'active' | 'suspended' | 'cancelled' | 'ended'

export type ContractRevision = {
  number: number
  kind: 'initial' | 'amendment' | 'renewal'
  effectiveFrom: string
  recurrence: Recurrence
  readjustmentBasisPoints: number | null
  reason: string | null
  createdBy: string
  createdAt: string
  lines: Array<{
    lineId: string
    itemId: string
    description: string
    quantity: string
    unitPrice: string
  }>
}

export type Contract = {
  id: string
  customerId: string
  currency: string
  startsOn: string
  endsOn: string | null
  billingDay: number
  autoRenew: boolean
  termMonths: number | null
  paymentTermDays: number[]
  notes: string | null
  stage: 'draft' | 'active' | 'discarded'
  status: ContractStatus
  cancelledFrom: string | null
  cancellationReason: string | null
  createdAt: string
  revisions: ContractRevision[]
  suspensions: Array<{ id: string; from: string; until: string | null; reason: string }>
}

export type SchedulePeriod = {
  index: number
  startsOn: string
  endsOn: string
  competence: string
  billingOn: string
  revision: number
  amount: string
  billable: boolean
  excluded: 'suspended' | 'cancelled' | null
  billedPeriodId: string | null
  credited: boolean
}

export type BilledPeriod = {
  id: string
  competence: string
  revision: number
  startsOn: string
  endsOn: string
  issuedOn: string
  value: string
  runId: string | null
  billedBy: string
  billedAt: string
  credit: { reasonCode: CreditReason; reason: string; creditedOn: string; by: string } | null
  receivable: ReceivableEffect
  lines: Array<{
    entryId: string
    description: string
    quantity: string
    amount: string
    nfse: NfseEffect
  }>
}

export const CREDIT_REASONS = ['not-provided', 'billing-error'] as const
export type CreditReason = (typeof CREDIT_REASONS)[number]

export type RunOutcome = 'pending' | 'billed' | 'skipped' | 'refused'

export type RunItem = {
  contractId: string
  customerId: string
  outcome: RunOutcome
  reason: string | null
  billedPeriodId: string | null
}

export type BillingRun = {
  id: string
  competence: string
  status: 'running' | 'completed'
  requestedBy: string
  startedAt: string
  finishedAt: string | null
  totals: Record<RunOutcome, number>
  items?: RunItem[]
}

export type BillingPreview = {
  competence: string
  totals: Record<RunOutcome, number>
  items: Array<{
    contractId: string
    customerId: string
    outcome: Exclude<RunOutcome, 'pending'>
    reason: string | null
    revision: number
    billingOn: string
    amount: { amount: string; currency: string }
  }>
}

export type BillingGap = {
  billedPeriodId: string
  contractId: string
  competence: string
  billedAt: string
  receivablePosted: boolean
  linesWithoutNfse: number
}

export type BillingOverview = {
  thresholdSeconds: number
  runs: BillingRun[]
  awaitingReceivable: BillingGap[]
  awaitingNfse: BillingGap[]
}

/** What a line still owes: sold less delivered, never below zero. */
export function remainingOf(line: Pick<ServiceOrderLine, 'quantity' | 'delivered'>): string {
  const remaining = Number(line.quantity) - Number(line.delivered)
  return remaining > 0 ? String(Number(remaining.toFixed(6))) : '0'
}

/** How much of an order has been delivered, as a share of its quantities. */
export function deliveredShare(lines: readonly ServiceOrderLine[]): number {
  const sold = lines.reduce((sum, line) => sum + Number(line.quantity), 0)
  if (sold === 0) return 0
  const delivered = lines.reduce((sum, line) => sum + Number(line.delivered), 0)
  return Math.min(100, Math.round((delivered / sold) * 100))
}

/** The revision in force today: the latest to take effect on or before it. */
export function revisionInForce(
  revisions: readonly ContractRevision[],
  day: string,
): ContractRevision | null {
  return revisions
    .filter((revision) => revision.effectiveFrom <= day)
    .reduce<ContractRevision | null>(
      (found, revision) =>
        !found ||
        found.effectiveFrom < revision.effectiveFrom ||
        (found.effectiveFrom === revision.effectiveFrom && revision.number > found.number)
          ? revision
          : found,
      null,
    )
}

/** What a revision bills per period, in minor units. */
export function periodAmount(revision: Pick<ContractRevision, 'lines'>): string {
  const total = revision.lines.reduce(
    (sum, line) => sum + Number(line.quantity) * Number(line.unitPrice),
    0,
  )
  return String(Math.round(total))
}

/** The first period in the schedule that has not been billed and is still billable. */
export function nextBillable(periods: readonly SchedulePeriod[]): SchedulePeriod | null {
  return periods.find((period) => period.billable && !period.billedPeriodId) ?? null
}

/** Periods that can be billed by hand today: billable, due and not billed. */
export function billableNow(periods: readonly SchedulePeriod[], today: string): SchedulePeriod[] {
  return periods.filter(
    (period) => period.billable && !period.billedPeriodId && period.billingOn <= today,
  )
}

/** A contract's changes take effect at a future period start. */
export function futureStarts(periods: readonly SchedulePeriod[], today: string): string[] {
  return periods
    .filter((period) => period.startsOn >= today && !period.billedPeriodId)
    .map((period) => period.startsOn)
}

/** The UTC competence month of a day, `YYYY-MM`. */
export function competenceOf(day: string): string {
  return day.slice(0, 7)
}

/** The months a person may run: this one and the eleven before it, newest first. */
export function recentCompetences(today: string, count = 12): string[] {
  const [year = 0, month = 1] = today.split('-').map(Number)
  return Array.from({ length: count }, (_, back) => {
    const date = new Date(Date.UTC(year, month - 1 - back, 1))
    return date.toISOString().slice(0, 7)
  })
}

/** The last day of a period that starts on `startsOn` and lasts `months` (an end date). */
export function periodEnd(startsOn: string, months: number): string {
  const [year = 0, month = 1] = startsOn.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1 + months, 0)).toISOString().slice(0, 10)
}

/** The UTC day, as Sales counts days. */
export function utcToday(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}

/** Where a receivable is shown: the posted title itself, or the draft by its reference. */
export function receivableHref(effect: ReceivableEffect | undefined, reference: string): string {
  if (effect?.titleId) return `/app/finance/receivables?open=${effect.titleId}`
  return `/app/finance/receivables?search=${encodeURIComponent(reference)}`
}

/** Where an NFS-e is shown, when Fiscal reported one. */
export function nfseHref(effect: NfseEffect | undefined): string | null {
  return effect?.documentId ? `/app/fiscal/documents?open=${effect.documentId}` : null
}

/**
 * The state of a receivable, as a status label key. Sales hears of a receivable once it is
 * posted; a draft of a delivery that was cancelled, or of a period that was credited, is
 * withdrawn by Financial and never posted.
 */
export function receivableState(effect: ReceivableEffect | undefined, withdrawn = false): string {
  if (effect?.reversedAt) return 'reversed'
  if (effect?.postedAt) return 'posted'
  return withdrawn ? 'withdrawn' : 'draft'
}

/** The state of an NFS-e, as a status label key: what Fiscal reported, or waiting. */
export function nfseState(effect: NfseEffect | undefined): string {
  return effect?.status ?? 'awaiting-nfse'
}

/** The receivable reference Financial prints for a delivery or a billed period. */
export function deliveryReference(deliveryId: string): string {
  return reference('SV', deliveryId)
}

export function periodReference(billedPeriodId: string): string {
  return reference('CT', billedPeriodId)
}

/** A customer's service orders and contracts, newest first. */
export function customerServices(
  customerId: string,
  orders: readonly ServiceOrder[],
  contracts: readonly Contract[],
): { orders: ServiceOrder[]; contracts: Contract[] } {
  const newest = (left: { createdAt: string }, right: { createdAt: string }) =>
    right.createdAt.localeCompare(left.createdAt)
  return {
    orders: orders.filter((order) => order.customerId === customerId).sort(newest),
    contracts: contracts.filter((contract) => contract.customerId === customerId).sort(newest),
  }
}

/** Sums preview or run items by outcome, whatever the server's totals say. */
export function totalsOf(items: readonly { outcome: string }[]): Record<RunOutcome, number> {
  const totals: Record<RunOutcome, number> = { pending: 0, billed: 0, skipped: 0, refused: 0 }
  for (const item of items) if (item.outcome in totals) totals[item.outcome as RunOutcome] += 1
  return totals
}
