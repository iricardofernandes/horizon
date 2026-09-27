import { and, asc, count, eq, inArray, lte, type SQL, sql } from 'drizzle-orm'
import type { Transaction } from './crm-store'
import { mapFact } from './crm-store'
import { type AccountSealer, KeyRing, mapActivity, mapNote, mapTask } from './record-store'
import * as schema from './schema'

/**
 * A record's text is `null` once its account's key is destroyed: the reads say so
 * instead of showing the placeholder a command would load (Phase 57).
 */
async function readable(keys: KeyRing, accountId: string): Promise<boolean> {
  return (await keys.keyOf(accountId)) !== null
}

async function activityView(keys: KeyRing, row: typeof schema.activities.$inferSelect) {
  const { tenantId: _, ...snapshot } = (await mapActivity(keys, row)).toSnapshot()
  return (await readable(keys, row.accountId))
    ? snapshot
    : { ...snapshot, title: null, summary: null }
}

async function taskView(keys: KeyRing, row: typeof schema.tasks.$inferSelect, now: Date) {
  const task = await mapTask(keys, row)
  const { tenantId: _, ...snapshot } = task.toSnapshot()
  const view = { ...snapshot, overdue: task.isOverdue(now) }
  return (await readable(keys, row.accountId)) ? view : { ...view, title: null }
}

async function noteView(
  keys: KeyRing,
  row: typeof schema.notes.$inferSelect,
  revisions: readonly (typeof schema.noteRevisions.$inferSelect)[],
) {
  const { tenantId: _, ...snapshot } = (await mapNote(keys, row, revisions)).toSnapshot()
  if (await readable(keys, row.accountId)) return snapshot
  return {
    ...snapshot,
    body: null,
    revisions: snapshot.revisions.map((revision) => ({ ...revision, body: null })),
  }
}

export async function activityDetail(
  tx: Transaction,
  sealer: AccountSealer,
  tenantId: string,
  id: string,
) {
  const [row] = await tx
    .select()
    .from(schema.activities)
    .where(eq(schema.activities.id, id))
    .limit(1)
  return row ? activityView(new KeyRing(tx, tenantId, sealer), row) : null
}

export async function taskDetail(
  tx: Transaction,
  sealer: AccountSealer,
  tenantId: string,
  id: string,
  now: Date,
) {
  const [row] = await tx.select().from(schema.tasks).where(eq(schema.tasks.id, id)).limit(1)
  return row ? taskView(new KeyRing(tx, tenantId, sealer), row, now) : null
}

export async function noteDetail(
  tx: Transaction,
  sealer: AccountSealer,
  tenantId: string,
  id: string,
) {
  const [row] = await tx.select().from(schema.notes).where(eq(schema.notes.id, id)).limit(1)
  if (!row) return null
  const revisions = await tx
    .select()
    .from(schema.noteRevisions)
    .where(eq(schema.noteRevisions.noteId, id))
  return noteView(new KeyRing(tx, tenantId, sealer), row, revisions)
}

export interface TaskFilter {
  readonly assigneeId: string | null
  readonly accountId: string | null
  readonly status: string | null
  readonly dueBefore: Date | null
  readonly limit: number
  readonly offset: number
}

export async function listTasks(
  tx: Transaction,
  sealer: AccountSealer,
  tenantId: string,
  filter: TaskFilter,
  now: Date,
) {
  const conditions = [
    filter.assigneeId ? eq(schema.tasks.assigneeId, filter.assigneeId) : undefined,
    filter.accountId ? eq(schema.tasks.accountId, filter.accountId) : undefined,
    filter.status ? eq(schema.tasks.status, filter.status) : undefined,
    filter.dueBefore ? lte(schema.tasks.dueAt, filter.dueBefore) : undefined,
  ].filter((condition): condition is SQL => condition !== undefined)
  const where = conditions.length ? and(...conditions) : undefined
  const [rows, [total]] = await Promise.all([
    tx
      .select()
      .from(schema.tasks)
      .where(where)
      .orderBy(asc(schema.tasks.dueAt), asc(schema.tasks.id))
      .limit(filter.limit)
      .offset(filter.offset),
    tx.select({ value: count() }).from(schema.tasks).where(where),
  ])
  const keys = new KeyRing(tx, tenantId, sealer)
  const data = []
  for (const row of rows) data.push(await taskView(keys, row, now))
  return { data, total: total?.value ?? 0 }
}

export type TimelineScope = { readonly accountId: string } | { readonly opportunityId: string }

export interface TimelinePage {
  readonly limit: number
  readonly offset: number
}

interface TimelineKey {
  readonly kind: 'activity' | 'task' | 'note' | 'opportunity-event'
  readonly id: string
  readonly at: Date
}

/**
 * The records of an account or an opportunity and its opportunity history, newest first
 * (Phase 57). The order and the page are decided in SQL over the ids and instants alone;
 * only the page's records are then read and opened.
 */
function timelineKeys(scope: TimelineScope): SQL {
  if ('opportunityId' in scope) {
    const about = (table: string) =>
      sql`${sql.raw(table)}.subject_type = 'opportunity' and ${sql.raw(table)}.subject_id = ${scope.opportunityId}`
    return sql`
      select 'activity' as kind, a.id::text as id, a.occurred_at as at from activities a where ${about('a')}
      union all select 'task', t.id::text, t.created_at from tasks t where ${about('t')}
      union all select 'note', n.id::text, n.created_at from notes n where ${about('n')}
      union all select 'opportunity-event', e.opportunity_id::text || ':' || e.sequence, e.occurred_at
        from opportunity_events e where e.opportunity_id = ${scope.opportunityId}`
  }
  return sql`
    select 'activity' as kind, a.id::text as id, a.occurred_at as at from activities a where a.account_id = ${scope.accountId}
    union all select 'task', t.id::text, t.created_at from tasks t where t.account_id = ${scope.accountId}
    union all select 'note', n.id::text, n.created_at from notes n where n.account_id = ${scope.accountId}
    union all select 'opportunity-event', e.opportunity_id::text || ':' || e.sequence, e.occurred_at
      from opportunity_events e join opportunities o on o.tenant_id = e.tenant_id and o.id = e.opportunity_id
      where o.account_id = ${scope.accountId}`
}

type Details = Map<string, unknown>

async function activityDetails(tx: Transaction, keys: KeyRing, ids: string[], details: Details) {
  if (!ids.length) return
  for (const row of await tx
    .select()
    .from(schema.activities)
    .where(inArray(schema.activities.id, ids)))
    details.set(`activity:${row.id}`, await activityView(keys, row))
}

async function taskDetails(
  tx: Transaction,
  keys: KeyRing,
  ids: string[],
  details: Details,
  now: Date,
) {
  if (!ids.length) return
  for (const row of await tx.select().from(schema.tasks).where(inArray(schema.tasks.id, ids)))
    details.set(`task:${row.id}`, await taskView(keys, row, now))
}

/** A note on the timeline shows what it says now and how often it was corrected. */
async function noteDetails(tx: Transaction, keys: KeyRing, ids: string[], details: Details) {
  if (!ids.length) return
  const revisions = await tx
    .select()
    .from(schema.noteRevisions)
    .where(inArray(schema.noteRevisions.noteId, ids))
  for (const row of await tx.select().from(schema.notes).where(inArray(schema.notes.id, ids))) {
    const mine = revisions.filter((revision) => revision.noteId === row.id)
    const { revisions: history, ...current } = await noteView(keys, row, mine)
    details.set(`note:${row.id}`, {
      ...current,
      revisionCount: history.length,
      lastRevisedAt: history.at(-1)?.writtenAt ?? current.createdAt,
    })
  }
}

/** One read for the histories on this page; a history is short and read whole. */
async function eventDetails(tx: Transaction, ids: string[], details: Details) {
  if (!ids.length) return
  const opportunityIds = [...new Set(ids.map((id) => id.split(':')[0] ?? ''))]
  for (const row of await tx
    .select()
    .from(schema.opportunityEvents)
    .where(inArray(schema.opportunityEvents.opportunityId, opportunityIds))) {
    const id = `${row.opportunityId}:${row.sequence}`
    if (ids.includes(id))
      details.set(`opportunity-event:${id}`, { opportunityId: row.opportunityId, ...mapFact(row) })
  }
}

export async function timeline(
  tx: Transaction,
  sealer: AccountSealer,
  tenantId: string,
  scope: TimelineScope,
  page: TimelinePage,
  now: Date,
) {
  const union = timelineKeys(scope)
  const [keysResult, totalResult] = await Promise.all([
    tx.execute(
      sql`select kind, id, at from (${union}) entries order by at desc, kind, id limit ${page.limit} offset ${page.offset}`,
    ),
    tx.execute(sql`select count(*)::int as total from (${union}) entries`),
  ])
  const entries = (keysResult as unknown as { kind: string; id: string; at: string | Date }[]).map(
    (row): TimelineKey => ({
      kind: row.kind as TimelineKey['kind'],
      id: row.id,
      at: new Date(row.at),
    }),
  )
  const total = Number((totalResult as unknown as { total: number }[])[0]?.total ?? 0)
  const ids = (kind: TimelineKey['kind']) =>
    entries.filter((entry) => entry.kind === kind).map((entry) => entry.id)
  const keys = new KeyRing(tx, tenantId, sealer)
  const details: Details = new Map()
  await activityDetails(tx, keys, ids('activity'), details)
  await taskDetails(tx, keys, ids('task'), details, now)
  await noteDetails(tx, keys, ids('note'), details)
  await eventDetails(tx, ids('opportunity-event'), details)
  return {
    // The record is nested: an activity has a `kind` of its own (call, meeting…).
    data: entries.map((entry) => ({
      kind: entry.kind,
      at: entry.at,
      record: details.get(`${entry.kind}:${entry.id}`) as Record<string, unknown>,
    })),
    total,
  }
}
