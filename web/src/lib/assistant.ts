/**
 * The web side of the in-app assistant (Phase 76). The agent service decides everything —
 * whether it is on, what it reads, what it may cite — with the person's own token; this
 * only shows it.
 */

/** The notice an owner accepts to turn the assistant on; the agent knows the same version. */
export const ASSISTANT_NOTICE_VERSION = 'assistant-notice-v1'
export const QUESTION_MAX = 2000

export type AssistantStatus = {
  enabled: boolean
  available: boolean
  provider: string
  model: string
  notice: {
    version: string
    accepted: boolean
    acceptedBy: string | null
    acceptedAt: string | null
  }
  budget: { month: string; monthlyTokens: number; spentTokens: number; questions: number }
}

export type Statement = { text: string; sources: string[]; found: boolean }

export type AssistantSource =
  | {
      id: string
      kind: 'document'
      attachmentId: string
      record: { module: string; recordType: string; recordId: string }
      screen: string
      position: { chunk: number; of: number }
      excerpt: string
      cited: boolean
    }
  | {
      id: string
      kind: 'record'
      tool: string
      module: string
      screen: string
      rows: number | null
      cited: boolean
    }

export type AssistantOutcome = 'answered' | 'stopped-budget' | 'stopped-off'

export type AssistantTurn = {
  question: string
  outcome: AssistantOutcome
  statements: Statement[]
  sources: AssistantSource[]
  askedAt: string
}

export type AssistantAnswer = {
  conversationId: string
  turn: number
  outcome: AssistantOutcome
  statements: Statement[]
  sources: AssistantSource[]
}

export type ConversationSummary = {
  id: string
  title: string
  turns: number
  updatedAt: string
  expiresAt: string
}

export type Readiness = 'ready' | 'off' | 'unavailable' | 'budget-spent'

/** Whether a question can be asked now, and if not, why: the screen says it before sending. */
export function readinessOf(status: AssistantStatus): Readiness {
  if (!status.enabled) return 'off'
  if (!status.available) return 'unavailable'
  if (status.budget.spentTokens >= status.budget.monthlyTokens) return 'budget-spent'
  return 'ready'
}

/** The share of the month's budget spent, 0 to 100. */
export function budgetPercent(status: AssistantStatus): number {
  const { spentTokens, monthlyTokens } = status.budget
  return monthlyTokens > 0 ? Math.min(100, Math.round((spentTokens / monthlyTokens) * 100)) : 100
}

/** A refusal's code, as the agent answered it, mapped to what the screen says. */
export function refusalOf(code: unknown): Readiness | 'failed' {
  switch (code) {
    case 'assistant-off':
      return 'off'
    case 'assistant-unavailable':
      return 'unavailable'
    case 'assistant-budget-spent':
      return 'budget-spent'
    default:
      return 'failed'
  }
}

/** The turn a fresh answer makes, so the screen shows it without asking again. */
export function turnOf(question: string, answer: AssistantAnswer, askedAt: Date): AssistantTurn {
  return {
    question,
    outcome: answer.outcome,
    statements: answer.statements,
    sources: answer.sources,
    askedAt: askedAt.toISOString(),
  }
}

/** The sources beside an answer: those its statements cite first, then the rest it read. */
export function sourcesBeside(sources: readonly AssistantSource[]): AssistantSource[] {
  return [...sources].sort((a, b) => Number(b.cited) - Number(a.cited))
}
