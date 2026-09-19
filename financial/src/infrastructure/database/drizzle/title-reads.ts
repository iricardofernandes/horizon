import { and, asc, count, desc, eq, ilike, inArray, lt, ne, or, type SQL, sql } from 'drizzle-orm'
import type { TitleDirection, TitleSnapshot } from '@/domain/entities/title'
import * as schema from './schema'
import { originOf } from './title-origin'
import { loadTitles, type Transaction } from './title-store'

export const TITLE_VIEWS = [
  'all',
  'forecast',
  'draft',
  'awaiting-approval',
  'open',
  'overdue',
  'settled',
  'closed',
] as const
export type TitleView = (typeof TITLE_VIEWS)[number]

export interface TitleQuery {
  readonly view: TitleView
  readonly search?: string | undefined
  readonly partyId?: string | undefined
  /** The caller's calendar date: what is overdue depends on where "today" is (ADR 0043). */
  readonly today: string
  readonly limit: number
  readonly offset: number
}

export interface TitleRow {
  readonly id: string
  readonly documentNumber: string
  readonly partyId: string
  readonly partyName: string | null
  readonly origin: TitleSnapshot['origin']
  readonly currency: string
  readonly issuedOn: string
  readonly nextDueOn: string | null
  readonly status: string
  readonly stage: string
  readonly settlementState: string
  readonly approvalState: string
  readonly overdue: boolean
  readonly total: string
  readonly outstanding: string
}

const titles = schema.titles

/**
 * A forecast is money expected, not owed, so it belongs to no view but its own — including
 * `all`, which is what everyone reads as "the receivables". Seeing expected money mixed
 * into that list is how a workspace ends up believing it is owed more than it is.
 */
const effective = eq(titles.stage, 'effective')

function viewCondition(view: TitleView, today: string): SQL | undefined {
  const posted = and(effective, eq(titles.status, 'posted'))
  switch (view) {
    case 'forecast':
      return and(eq(titles.stage, 'forecast'), eq(titles.status, 'draft'))
    case 'draft':
      return and(effective, eq(titles.status, 'draft'))
    case 'awaiting-approval':
      return and(effective, eq(titles.status, 'draft'), eq(titles.approvalState, 'pending'))
    case 'open':
      return and(posted, ne(titles.settlementState, 'settled'))
    case 'overdue':
      return and(posted, ne(titles.settlementState, 'settled'), lt(titles.nextDueOn, today))
    case 'settled':
      return and(posted, eq(titles.settlementState, 'settled'))
    case 'closed':
      // A title that went nowhere is history whichever stage it was in, so a withdrawn
      // forecast is found here rather than vanishing.
      return inArray(titles.status, ['cancelled', 'reversed'])
    default:
      return effective
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

export async function listTitles(
  tx: Transaction,
  direction: TitleDirection,
  query: TitleQuery,
): Promise<{ data: TitleRow[]; total: number }> {
  const search = query.search?.trim()
  const pattern = search ? `%${escapeLike(search)}%` : undefined
  const where = and(
    eq(titles.direction, direction),
    viewCondition(query.view, query.today),
    query.partyId ? eq(titles.partyId, query.partyId) : undefined,
    pattern
      ? or(ilike(titles.documentNumber, pattern), ilike(schema.partyProjection.legalName, pattern))
      : undefined,
  )
  const joined = and(
    eq(schema.partyProjection.tenantId, titles.tenantId),
    eq(schema.partyProjection.partyId, titles.partyId),
  )
  const [rows, [counted]] = await Promise.all([
    tx
      .select({ title: titles, partyName: schema.partyProjection.legalName })
      .from(titles)
      .leftJoin(schema.partyProjection, joined)
      .where(where)
      .orderBy(desc(titles.issuedOn), desc(titles.id))
      .limit(query.limit)
      .offset(query.offset),
    tx
      .select({ value: count() })
      .from(titles)
      .leftJoin(schema.partyProjection, joined)
      .where(where),
  ])
  return {
    total: counted?.value ?? 0,
    data: rows.map(({ title, partyName }) => ({
      id: title.id,
      documentNumber: title.documentNumber,
      partyId: title.partyId,
      partyName,
      origin: originOf(title.originType, title.originDocumentId),
      currency: title.currency,
      issuedOn: title.issuedOn,
      nextDueOn: title.nextDueOn,
      status: title.status,
      stage: title.stage,
      settlementState: title.settlementState,
      approvalState: title.approvalState,
      overdue:
        title.status === 'posted' && title.nextDueOn !== null && title.nextDueOn < query.today,
      total: title.total.toString(),
      outstanding: title.outstanding.toString(),
    })),
  }
}

export interface TimelineEntry {
  readonly sequence: number
  readonly action: string
  readonly actor: string
  readonly occurredAt: Date
  readonly details: Readonly<Record<string, unknown>>
}

export async function titleDetail(
  tx: Transaction,
  direction: TitleDirection,
  id: string,
  today: string,
): Promise<
  | (TitleSnapshot & {
      partyName: string | null
      overdue: boolean
      timeline: readonly TimelineEntry[]
    })
  | null
> {
  const rows = await tx
    .select()
    .from(titles)
    .where(and(eq(titles.id, id), eq(titles.direction, direction)))
    .limit(1)
  const [title] = await loadTitles(tx, rows)
  const row = rows[0]
  if (!title || !row) return null
  const [party] = await tx
    .select({ legalName: schema.partyProjection.legalName })
    .from(schema.partyProjection)
    .where(eq(schema.partyProjection.partyId, row.partyId))
  const timeline = await tx
    .select({
      sequence: schema.auditLog.sequence,
      action: schema.auditLog.action,
      actor: schema.auditLog.actor,
      occurredAt: schema.auditLog.occurredAt,
      details: schema.auditLog.details,
    })
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.subjectType, 'title'), eq(schema.auditLog.subjectId, id)))
    .orderBy(asc(schema.auditLog.sequence))
  return {
    ...title.toSnapshot(),
    partyName: party?.legalName ?? null,
    overdue: row.status === 'posted' && row.nextDueOn !== null && row.nextDueOn < today,
    timeline,
  }
}

export const AGING_BUCKETS = ['current', 'days1To30', 'days31To60', 'days61To90', 'over90'] as const

export interface TitlesSummary {
  readonly drafts: number
  readonly awaitingApproval: number
  /** How many forecasts are open, and what they add up to per currency. */
  readonly forecasts: number
  readonly expected: readonly { readonly currency: string; readonly total: string }[]
  readonly currencies: readonly {
    readonly currency: string
    readonly outstanding: string
    readonly overdue: string
    readonly dueWithin7Days: string
    readonly aging: Readonly<Record<(typeof AGING_BUCKETS)[number], string>>
  }[]
}

/**
 * Aging of what customers still owe, by installment. Computed from the same stored balances
 * the list and the detail show, so the three always agree at the same `today`.
 */
export async function titlesSummary(
  tx: Transaction,
  direction: TitleDirection,
  today: string,
): Promise<TitlesSummary> {
  const installments = schema.titleInstallments
  const late = sql`(${today}::date - ${installments.dueOn})`
  const within = (condition: SQL) =>
    sql<string>`coalesce(sum(${installments.outstanding}) filter (where ${condition}), 0)::text`
  const [drafts] = await tx
    .select({
      value: count(),
      awaitingApproval: sql<number>`count(*) filter (where ${titles.approvalState} = 'pending')::int`,
    })
    .from(titles)
    .where(
      and(
        eq(titles.direction, direction),
        eq(titles.status, 'draft'),
        eq(titles.stage, 'effective'),
      ),
    )
  // Expected money is counted apart from what is owed, and never added into it.
  const expected = await tx
    .select({
      currency: titles.currency,
      total: sql<string>`coalesce(sum(${titles.total}), 0)::text`,
      value: count(),
    })
    .from(titles)
    .where(
      and(
        eq(titles.direction, direction),
        eq(titles.status, 'draft'),
        eq(titles.stage, 'forecast'),
      ),
    )
    .groupBy(titles.currency)
    .orderBy(asc(titles.currency))
  const rows = await tx
    .select({
      currency: titles.currency,
      outstanding: sql<string>`coalesce(sum(${installments.outstanding}), 0)::text`,
      overdue: within(sql`${late} > 0`),
      dueWithin7Days: within(sql`${late} between -7 and 0`),
      current: within(sql`${late} <= 0`),
      days1To30: within(sql`${late} between 1 and 30`),
      days31To60: within(sql`${late} between 31 and 60`),
      days61To90: within(sql`${late} between 61 and 90`),
      over90: within(sql`${late} > 90`),
    })
    .from(installments)
    .innerJoin(
      titles,
      and(eq(titles.tenantId, installments.tenantId), eq(titles.id, installments.titleId)),
    )
    .where(
      and(
        eq(titles.direction, direction),
        eq(titles.status, 'posted'),
        eq(titles.stage, 'effective'),
        sql`${installments.outstanding} > 0`,
      ),
    )
    .groupBy(titles.currency)
    .orderBy(asc(titles.currency))
  return {
    drafts: drafts?.value ?? 0,
    awaitingApproval: drafts?.awaitingApproval ?? 0,
    forecasts: expected.reduce((sum, row) => sum + row.value, 0),
    expected: expected.map((row) => ({ currency: row.currency, total: row.total })),
    currencies: rows.map((row) => ({
      currency: row.currency,
      outstanding: row.outstanding,
      overdue: row.overdue,
      dueWithin7Days: row.dueWithin7Days,
      aging: {
        current: row.current,
        days1To30: row.days1To30,
        days31To60: row.days31To60,
        days61To90: row.days61To90,
        over90: row.over90,
      },
    })),
  }
}

/** Parties a title may name: customers for receivables, suppliers for payables. */
export async function listCounterparties(
  tx: Transaction,
  role: 'customer' | 'supplier',
): Promise<readonly { partyId: string; legalName: string }[]> {
  const rows = await tx
    .select({
      partyId: schema.partyProjection.partyId,
      legalName: schema.partyProjection.legalName,
    })
    .from(schema.partyProjection)
    .where(
      and(
        eq(schema.partyProjection.erased, false),
        eq(schema.partyProjection.active, true),
        sql`${role} = any(${schema.partyProjection.roles})`,
      ),
    )
    .orderBy(asc(schema.partyProjection.legalName))
    .limit(500)
  return rows.flatMap((row) =>
    row.legalName ? [{ partyId: row.partyId, legalName: row.legalName }] : [],
  )
}
