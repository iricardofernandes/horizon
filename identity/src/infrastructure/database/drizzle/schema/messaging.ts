import { sql } from 'drizzle-orm'
import {
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * The transactional outbox (ADR 0024).
 *
 * A state change and its announcement live in two systems, and `commit(); publish()` is
 * not atomic — a crash between those lines loses the event permanently, with no error
 * anywhere and no way to detect it afterwards. So the event is written **here, in the
 * same transaction as the change**. If the transaction commits, the event exists; if it
 * rolls back, neither does. There is no third state.
 *
 * A relay polls undispatched rows with `FOR UPDATE SKIP LOCKED`, so several replicas can
 * run with no coordination: each claims rows the others are not holding. The relay reads
 * across tenants, which the application role cannot do — it connects as `horizon_relay`,
 * a role with a policy on this table and no privilege on any business table at all
 * (ADR 0017's "distinct role and distinct code path", made concrete).
 *
 * `tenant_id` is stamped by a trigger from `app.current_tenant` rather than supplied by
 * the insert, so a row's tenant is whatever the transaction was actually scoped to and
 * cannot be written to say otherwise.
 */
export const outbox = pgTable(
  'outbox',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    /** The envelope's `eventId`, and the consumer's deduplication key (ADR 0030). */
    eventId: uuid('event_id').notNull(),
    eventType: text('event_type').notNull(),
    eventVersion: smallint('event_version').notNull(),
    /** When the fact became true — not when it was published. */
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** W3C trace id, so the asynchronous hop stays inside one trace (ADR 0033). */
    traceId: text('trace_id').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true, mode: 'date' }),
    attempts: smallint('attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  (table) => [
    uniqueIndex('outbox_event_id_key').on(table.eventId),
    // The relay's only query: undispatched, oldest first. A partial index keeps it the
    // size of the backlog rather than the size of history.
    index('outbox_undispatched_idx').on(table.createdAt).where(sql`dispatched_at IS NULL`),
  ],
)

/**
 * The inbox (ADR 0024).
 *
 * At-least-once delivery is the *consequence* of the outbox — the relay can publish and
 * crash before marking the row — and it is accepted rather than fought, because
 * exactly-once delivery does not exist over a network. So every consumer inserts an inbox
 * row **inside the same transaction as the effect**: a redelivery violates the unique
 * constraint, the transaction rolls back, the message is acknowledged, and the effect
 * happened exactly once.
 *
 * Identity consumes no events — it is upstream of everything else — so this table stays
 * empty here. It exists anyway, because phase 5 extracts these patterns for four modules
 * that do consume, and a pattern documented from a table nobody built is a guess. Its
 * retention window is set longer than the maximum possible redelivery window.
 */
export const inbox = pgTable(
  'inbox',
  {
    sourceModule: text('source_module').notNull(),
    eventId: uuid('event_id').notNull(),
    eventType: text('event_type').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex('inbox_source_event_key').on(table.sourceModule, table.eventId)],
)
