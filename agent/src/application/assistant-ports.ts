import type { GenerationUsage } from './generation'

/** A workspace's choice about the assistant (ADR 0069): off until an owner accepts the notice. */
export interface AssistantSettings {
  readonly enabled: boolean
  readonly noticeVersion: string | null
  readonly acceptedBy: string | null
  readonly acceptedAt: Date | null
  readonly monthlyBudgetTokens: number
}

export interface SettingsChange {
  readonly enabled?: boolean
  readonly noticeVersion?: string
  readonly monthlyBudgetTokens?: number
}

export interface MonthUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly questions: number
}

export interface StoredTurn {
  readonly ordinal: number
  readonly sealed: Buffer
  readonly createdAt: Date
}

export interface ConversationSummary {
  readonly id: string
  readonly turns: number
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly expiresAt: Date
  /** The first turn, sealed: its question is the conversation's title. */
  readonly first: StoredTurn | null
}

export interface ErasureEvent {
  readonly tenantId: string
  readonly sourceModule: string
  readonly eventId: string
  readonly eventType: string
}

export abstract class AssistantStore {
  abstract settings(tenantId: string): Promise<AssistantSettings>
  /** The change and its audit entry, in one transaction. */
  abstract changeSettings(
    tenantId: string,
    change: SettingsChange,
    by: string,
    at: Date,
  ): Promise<AssistantSettings>
  abstract usage(tenantId: string, month: string): Promise<MonthUsage>
  abstract addUsage(
    tenantId: string,
    month: string,
    usage: GenerationUsage,
    questions: number,
  ): Promise<void>
  /** The person's wrapped key, created with `create` the first time. */
  abstract keyOf(tenantId: string, userId: string, create: () => string, at: Date): Promise<string>
  /** A conversation of the person that has not expired, with its turns in order. */
  abstract conversation(
    tenantId: string,
    userId: string,
    conversationId: string,
    now: Date,
  ): Promise<{ readonly turns: readonly StoredTurn[] } | null>
  /** A new turn, sealed by `seal` for its place; the conversation is created or extended. */
  abstract appendTurn(
    tenantId: string,
    userId: string,
    conversationId: string,
    seal: (ordinal: number) => Buffer,
    at: Date,
    expiresAt: Date,
  ): Promise<number>
  abstract conversations(
    tenantId: string,
    userId: string,
    now: Date,
  ): Promise<ConversationSummary[]>
  abstract deleteConversation(
    tenantId: string,
    userId: string,
    conversationId: string,
  ): Promise<boolean>
  /** The person's key destroyed and their conversations deleted, once per event. */
  abstract erase(event: ErasureEvent, userId: string): Promise<boolean>
  abstract purgeExpired(): Promise<number>
}

/** A person's turns sealed under a key of theirs, which erasure destroys (ADR 0068). */
export abstract class TurnSealer {
  abstract newKey(tenantId: string, userId: string): string
  abstract seal(wrappedKey: string, place: TurnPlace, plaintext: string): Buffer
  abstract open(wrappedKey: string, place: TurnPlace, sealed: Buffer): string
}

export interface TurnPlace {
  readonly tenantId: string
  readonly userId: string
  readonly conversationId: string
  readonly ordinal: number
}

export interface AssistantMetrics {
  answered(outcome: string, seconds: number): void
  tokens(usage: GenerationUsage): void
}
