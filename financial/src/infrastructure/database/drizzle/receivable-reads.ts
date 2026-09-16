import { and, asc, count, desc, eq, ilike, inArray, lt, ne, or, type SQL, sql } from 'drizzle-orm'
import type { TitleSnapshot } from '@/domain/entities/title'
import * as schema from './schema'
import { loadTitles, type Transaction } from './title-store'

export const RECEIVABLE_VIEWS = ['all', 'draft', 'open', 'overdue', 'settled', 'closed'] as const
export type ReceivableView = (typeof RECEIVABLE_VIEWS)[number]

export interface ReceivableQuery {
  readonly view: ReceivableView
  readonly search?: string | undefined
  readonly partyId?: string | undefined
  /** The caller's calendar date: what is overdue depends on where "today" is (ADR 0043). */
  readonly today: string
  readonly limit: number
  readonly offset: number
}

export interface ReceivableRow {
  readonly id: string
  readonly documentNumber: string
  readonly partyId: string
  readonly partyName: string | null
  readonly origin: TitleSnapshot['origin']
  readonly currency: string
  readonly issuedOn: string
  readonly nextDueOn: string | null
  readonly status: string
  readonly settlementState: string
  readonly overdue: boolean
  readonly total: string
  readonly outstanding: string
}

const titles = schema.titles

function viewCondition(view: ReceivableView, today: string): SQL | undefined {
  const posted = eq(titles.status, 'posted')
  switch (view) {
    case 'draft':
      return eq(titles.status, 'draft')
    case 'open':
      return and(posted, ne(titles.settlementState, 'settled'))
    case 'overdue':
      return and(posted, ne(titles.settlementState, 'settled'), lt(titles.nextDueOn, today))
    case 'settled':
      return and(posted, eq(titles.settlementState, 'settled'))
    case 'closed':
      return inArray(titles.status, ['cancelled', 'reversed'])
    default:
      return undefined
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

export async function listReceivables(
  tx: Transaction,
  query: ReceivableQuery,
): Promise<{ data: ReceivableRow[]; total: number }> {
  const search = query.search?.trim()
  const pattern = search ? `%${escapeLike(search)}%` : undefined
  const where = and(
    eq(titles.direction, 'receivable'),
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
      origin:
        title.originType === 'sales-order' && title.originOrderId
          ? { type: 'sales-order', orderId: title.originOrderId }
          : { type: 'manual' },
      currency: title.currency,
      issuedOn: title.issuedOn,
      nextDueOn: title.nextDueOn,
      status: title.status,
      settlementState: title.settlementState,
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

export async function receivableDetail(
  tx: Transaction,
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
    .where(and(eq(titles.id, id), eq(titles.direction, 'receivable')))
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

export interface ReceivablesSummary {
  readonly drafts: number
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
export async function receivablesSummary(
  tx: Transaction,
  today: string,
): Promise<ReceivablesSummary> {
  const installments = schema.titleInstallments
  const late = sql`(${today}::date - ${installments.dueOn})`
  const within = (condition: SQL) =>
    sql<string>`coalesce(sum(${installments.outstanding}) filter (where ${condition}), 0)::text`
  const [drafts] = await tx
    .select({ value: count() })
    .from(titles)
    .where(and(eq(titles.direction, 'receivable'), eq(titles.status, 'draft')))
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
        eq(titles.direction, 'receivable'),
        eq(titles.status, 'posted'),
        sql`${installments.outstanding} > 0`,
      ),
    )
    .groupBy(titles.currency)
    .orderBy(asc(titles.currency))
  return {
    drafts: drafts?.value ?? 0,
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

/** Parties a receivable may name: customers still present in the registry. */
export async function listCustomers(
  tx: Transaction,
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
        sql`'customer' = any(${schema.partyProjection.roles})`,
      ),
    )
    .orderBy(asc(schema.partyProjection.legalName))
    .limit(500)
  return rows.flatMap((row) =>
    row.legalName ? [{ partyId: row.partyId, legalName: row.legalName }] : [],
  )
}
