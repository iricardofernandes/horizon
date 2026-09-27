/** What the CRM API answers (Phases 55–59), as the screens read it. */
export const CRM_API = '/api/horizon/crm'

export type Money = { amount: string; currency: string }

export type Account = {
  id: string
  kind: 'organization' | 'person' | null
  legalName: string | null
  tradeName: string | null
  roles: string[]
  documentType: 'cpf' | 'cnpj' | 'foreign' | 'none' | null
  documentCountry: string | null
  ownerId: string | null
  sourceId: string | null
  segment: string | null
  tags: string[]
  status: 'active' | 'inactive' | 'erased'
}

export type Contact = {
  id: string
  accountId: string
  name: string | null
  jobTitle: string | null
  email: string | null
  phone: string | null
  lawfulBasis: string
  status: 'active' | 'inactive' | 'erased'
}

export type Owner = { userId: string; active: boolean }

export type Stage = {
  id: string
  name: string
  probabilityBps: number
  archived: boolean
  position: number
}

export type Pipeline = { id: string; name: string; archived: boolean; stages: Stage[] }

export type ListEntry = {
  id: string
  kind: 'source' | 'loss-reason'
  name: string
  archived: boolean
}

export type OpportunityStatus = 'open' | 'won' | 'lost'

export type Opportunity = {
  id: string
  accountId: string
  title: string
  contactIds: string[]
  ownerId: string
  sourceId: string | null
  expectedValue: Money
  expectedCloseOn: string
  pipelineId: string
  stageId: string
  probabilityBps: number
  status: OpportunityStatus
  lossReasonId: string | null
  lossNote: string | null
  closedOn: string | null
  conversion: { quoteId: string; quoteRoot: string; quoteVersion: number } | null
  version: number
  updatedAt: string
}

export type RecordedFact = {
  sequence: number
  actor: string
  occurredAt: string
  fact: { type: string } & Record<string, unknown>
}

export type LinkedQuote = {
  quoteRoot: string
  quoteId: string
  quoteVersion: number
  status: 'sent' | 'accepted' | 'rejected'
  total: Money | null
  seenAt: string
}

export type OpportunityDetail = Opportunity & { history: RecordedFact[]; quotes: LinkedQuote[] }

export type Subject = { type: 'account' | 'contact' | 'opportunity'; id: string }

export type Task = {
  id: string
  accountId: string
  subject: Subject
  title: string | null
  assigneeId: string
  dueAt: string
  remindAt: string | null
  remindedAt: string | null
  status: 'open' | 'completed' | 'cancelled'
  overdue: boolean
}

export type TimelineEntry = {
  kind: 'activity' | 'task' | 'note' | 'opportunity-event'
  at: string
  record: Record<string, unknown>
}

export type ForecastRow = {
  month: string
  key: string | null
  currency: string
  openCount: number
  openValue: string
  weightedValue: string
  wonCount: number
  wonValue: string
}

export type StageMetric = {
  stageId: string
  entered: number
  current: number
  exits: { moved: number; won: number; lost: number }
  timeInStage: { count: number; averageSeconds: number; medianSeconds: number }
}

export type PipelineMetrics = {
  cutoff: string
  settled: boolean
  stages: StageMetric[]
  conversions: { fromStageId: string; toStageId: string; count: number }[]
  outcomes: { won: number; lost: number; winRateBps: number | null }
  lossReasons: { lossReasonId: string; count: number }[]
}

/** The stages an opportunity may move into, in board order. */
export function activeStages(pipeline: Pipeline): Stage[] {
  return pipeline.stages.filter((stage) => !stage.archived).sort((a, b) => a.position - b.position)
}

/**
 * The board's columns: every active stage, and an archived one only while an open
 * opportunity still sits in it, so nothing on the board disappears.
 */
export function boardStages(pipeline: Pipeline, open: readonly Opportunity[]): Stage[] {
  const held = new Set(open.map((row) => row.stageId))
  return pipeline.stages
    .filter((stage) => !stage.archived || held.has(stage.id))
    .sort((a, b) => a.position - b.position)
}

/**
 * The stage a keyboard move lands on: the next or previous active stage, skipping
 * archived ones; null at either end.
 */
export function neighbourStage(
  pipeline: Pipeline,
  stageId: string,
  direction: 'next' | 'previous',
): Stage | null {
  const ordered = [...pipeline.stages].sort((a, b) => a.position - b.position)
  const index = ordered.findIndex((stage) => stage.id === stageId)
  if (index < 0) return null
  const step = direction === 'next' ? 1 : -1
  for (let at = index + step; at >= 0 && at < ordered.length; at += step) {
    const stage = ordered[at]
    if (stage && !stage.archived) return stage
  }
  return null
}

/** A person as the screens show them: their name when Identity told us, a short id if not. */
export function personLabel(
  names: ReadonlyMap<string, string>,
  userId: string | null,
  fallback: string,
): string {
  if (!userId) return fallback
  return names.get(userId) ?? userId.slice(0, 8)
}

export function accountName(account: Account | undefined, fallback: string): string {
  if (!account) return fallback
  return account.tradeName || account.legalName || fallback
}

/** Whether "convert to quote" must first make the account a customer in Parties. */
export function needsCustomerRole(account: Account): boolean {
  return !account.roles.includes('customer')
}

/** Percent from basis points, for display: 2500 → 25. */
export function percentOf(bps: number): number {
  return bps / 100
}

/** Seconds as whole days, hours or minutes, whichever reads best. */
export function durationParts(seconds: number): {
  unit: 'days' | 'hours' | 'minutes'
  value: number
} {
  if (seconds >= 86_400) return { unit: 'days', value: Math.round(seconds / 8_640) / 10 }
  if (seconds >= 3_600) return { unit: 'hours', value: Math.round(seconds / 360) / 10 }
  return { unit: 'minutes', value: Math.round(seconds / 60) }
}

/** An ISO instant from a `datetime-local` input, in the browser's own zone. */
export function instantFromLocal(value: string): string | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** A `datetime-local` value for an instant, in the browser's own zone. */
export function localInputOf(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}
