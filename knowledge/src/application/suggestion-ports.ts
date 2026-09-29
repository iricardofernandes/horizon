import type { CodeNeighbour, ExampleNeighbour, SuggestionKind } from '@/domain/suggestions'
import type { ReceivedEvent } from './ports'

/** One confirmed example, as the index keeps it: a vector, a label and a short reference. */
export interface ExampleWrite {
  readonly kind: SuggestionKind
  readonly sourceId: string
  readonly label: string | null
  readonly partyId: string | null
  readonly reference: string
  readonly embedding: readonly number[]
  readonly indexVersion: string
}

export interface TableState {
  readonly act: string
  readonly indexVersion: string
  readonly codes: number
}

export interface CodeWrite {
  readonly code: string
  readonly description: string
  readonly embedding: readonly number[]
}

/** The confirmed history of each tenant, one partition each, and the official table. */
export abstract class ExampleStore {
  /** Written once per event: false when the event was already handled. */
  abstract putExample(event: ReceivedEvent, example: ExampleWrite, now: Date): Promise<boolean>
  abstract relabel(
    event: ReceivedEvent,
    kind: SuggestionKind,
    sourceId: string,
    label: string | null,
    now: Date,
  ): Promise<boolean>
  abstract removeExample(
    event: ReceivedEvent,
    kind: SuggestionKind,
    sourceId: string,
  ): Promise<boolean>
  /** Every example that came from a party, gone with it (ADR 0068). */
  abstract removeParty(event: ReceivedEvent, partyId: string): Promise<boolean>
  abstract nearestExamples(
    tenantId: string,
    kind: SuggestionKind,
    vector: readonly number[],
    limit: number,
  ): Promise<ExampleNeighbour[]>
  abstract nearestCodes(vector: readonly number[], limit: number): Promise<CodeNeighbour[]>
  abstract tableState(): Promise<TableState | null>
  abstract clearTable(): Promise<void>
  abstract insertCodes(codes: readonly CodeWrite[], indexVersion: string): Promise<void>
  abstract markTable(state: TableState, at: Date): Promise<void>
}

/** A posted payable as Financial describes it to a viewer. */
export interface PayableDetail {
  readonly partyId: string
  readonly partyName: string | null
  readonly description: string | null
  readonly documentNumber: string
  readonly categoryId: string | null
}

/** Payables read through the gateway as the `knowledge` service client, a Financial viewer. */
export abstract class PayableSource {
  abstract read(tenantId: string, titleId: string): Promise<PayableDetail | null>
}

/** The official NCM table, as `scripts/build-ncm-table.mjs` writes it. */
export interface NcmTable {
  readonly act: string
  readonly codes: readonly (readonly [string, string])[]
}

export interface SuggestionMetrics {
  suggested(kind: SuggestionKind, seconds: number, count: number): void
  decided(kind: SuggestionKind, decision: 'accepted' | 'rejected'): void
}
