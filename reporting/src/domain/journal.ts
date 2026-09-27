/**
 * What the reporting journal holds (ADR 0058).
 *
 * Every event of the modules reports are built from, and nothing of `parties` or
 * `identity`: reports carry party and user ids, and names are read from their owners at
 * display time, so an erasure there needs nothing here. A field that may name a person is
 * removed before the row is written.
 */
export const JOURNALED_SOURCES = [
  'catalog',
  'crm',
  'financial',
  'fiscal',
  'inventory',
  'ledger',
  'procurement',
  'sales',
  'treasury',
] as const

export type Source = (typeof JOURNALED_SOURCES)[number]
export type Arrival = 'live' | 'replay'

/** Top-level payload fields removed before a row is stored, per source. */
export const REDACTED_FIELDS: Readonly<Partial<Record<Source, readonly string[]>>> = {
  // A supplier may be a person; reports read the supplier's id and ask Parties for a name.
  procurement: ['supplierName'],
}

export interface ReceivedEvent {
  readonly eventId: string
  readonly tenantId: string
  readonly eventType: string
  readonly eventVersion: number
  readonly occurredAt: string
  readonly traceId: string
  readonly payload: unknown
}

export interface JournalEntry {
  readonly source: Source
  readonly eventId: string
  readonly tenantId: string
  readonly eventType: string
  readonly eventVersion: number
  readonly occurredAt: Date
  readonly traceId: string
  readonly payload: Readonly<Record<string, unknown>>
  readonly arrival: Arrival
}

export function isJournaledSource(value: string): value is Source {
  return (JOURNALED_SOURCES as readonly string[]).includes(value)
}

/** The module an event type belongs to: the segment before the first dot. */
export function sourceOf(eventType: string): Source | null {
  const [module] = eventType.split('.', 1)
  return module && isJournaledSource(module) ? module : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function redact(source: Source, payload: Readonly<Record<string, unknown>>) {
  const fields = REDACTED_FIELDS[source] ?? []
  return Object.fromEntries(Object.entries(payload).filter(([field]) => !fields.includes(field)))
}

/** The row an event becomes, or null when its module is not journaled. */
export function journalEntryOf(event: ReceivedEvent, arrival: Arrival): JournalEntry | null {
  const source = sourceOf(event.eventType)
  if (!source) return null
  if (!isRecord(event.payload)) throw new Error('An event payload must be an object')
  return {
    source,
    eventId: event.eventId,
    tenantId: event.tenantId,
    eventType: event.eventType,
    eventVersion: event.eventVersion,
    occurredAt: new Date(event.occurredAt),
    traceId: event.traceId,
    payload: redact(source, event.payload),
    arrival,
  }
}
