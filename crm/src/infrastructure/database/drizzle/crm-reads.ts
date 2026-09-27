import { and, asc, count, desc, eq, ilike, inArray, or, type SQL, sql } from 'drizzle-orm'
import type { AccountSnapshot } from '@/domain/entities/account'
import type { ContactSnapshot } from '@/domain/entities/contact'
import {
  type ContactSealer,
  mapAccount,
  mapFact,
  mapListEntry,
  mapOpportunity,
  mapPipeline,
  type Transaction,
} from './crm-store'
import * as schema from './schema'

export interface AccountFilter {
  readonly search: string | null
  readonly role: string | null
  readonly ownerId: string | null
  readonly status: string | null
  readonly limit: number
  readonly offset: number
}

/** `%` and `_` typed by a person are literal characters, not wildcards. */
function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (match) => `\\${match}`)}%`
}

export async function listAccounts(
  tx: Transaction,
  filter: AccountFilter,
): Promise<{ data: readonly AccountSnapshot[]; total: number }> {
  const conditions: SQL[] = []
  if (filter.search) {
    const pattern = likePattern(filter.search)
    const match = or(
      ilike(schema.accounts.legalName, pattern),
      ilike(schema.accounts.tradeName, pattern),
    )
    if (match) conditions.push(match)
  }
  if (filter.role) conditions.push(sql`${filter.role} = ANY(${schema.accounts.roles})`)
  if (filter.ownerId) conditions.push(eq(schema.accounts.ownerId, filter.ownerId))
  if (filter.status) conditions.push(eq(schema.accounts.status, filter.status))
  const where = conditions.length ? and(...conditions) : undefined
  const [rows, [total]] = await Promise.all([
    tx
      .select()
      .from(schema.accounts)
      .where(where)
      .orderBy(asc(schema.accounts.legalName), asc(schema.accounts.id))
      .limit(filter.limit)
      .offset(filter.offset),
    tx.select({ value: count() }).from(schema.accounts).where(where),
  ])
  return { data: rows.map((row) => mapAccount(row).toSnapshot()), total: total?.value ?? 0 }
}

export async function accountDetail(
  tx: Transaction,
  sealer: ContactSealer,
  id: string,
): Promise<{ account: AccountSnapshot; contacts: readonly ContactSnapshot[] } | null> {
  const [row] = await tx.select().from(schema.accounts).where(eq(schema.accounts.id, id)).limit(1)
  if (!row) return null
  const contacts = await tx
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.accountId, id))
    .orderBy(asc(schema.contacts.createdAt), asc(schema.contacts.id))
  return {
    account: mapAccount(row).toSnapshot(),
    contacts: await Promise.all(
      contacts.map(async (contact) => (await sealer.map(tx, contact)).toSnapshot()),
    ),
  }
}

export async function contactDetail(
  tx: Transaction,
  sealer: ContactSealer,
  id: string,
): Promise<ContactSnapshot | null> {
  const [row] = await tx.select().from(schema.contacts).where(eq(schema.contacts.id, id)).limit(1)
  return row ? (await sealer.map(tx, row)).toSnapshot() : null
}

export function listOwners(tx: Transaction) {
  return tx
    .select({
      userId: schema.owners.userId,
      active: schema.owners.active,
      registeredAt: schema.owners.registeredAt,
      disabledAt: schema.owners.disabledAt,
    })
    .from(schema.owners)
    .orderBy(asc(schema.owners.registeredAt), asc(schema.owners.userId))
}

export async function listPipelines(tx: Transaction, includeArchived: boolean) {
  const rows = await tx
    .select()
    .from(schema.pipelines)
    .where(includeArchived ? undefined : eq(schema.pipelines.archived, false))
    .orderBy(asc(schema.pipelines.name), asc(schema.pipelines.id))
  if (!rows.length) return []
  const stages = await tx
    .select()
    .from(schema.pipelineStages)
    .where(
      inArray(
        schema.pipelineStages.pipelineId,
        rows.map((row) => row.id),
      ),
    )
  return rows.map((row) =>
    mapPipeline(
      row,
      stages.filter((stage) => stage.pipelineId === row.id),
    ).toSnapshot(),
  )
}

export async function pipelineDetail(tx: Transaction, id: string) {
  const [row] = await tx.select().from(schema.pipelines).where(eq(schema.pipelines.id, id)).limit(1)
  if (!row) return null
  const stages = await tx
    .select()
    .from(schema.pipelineStages)
    .where(eq(schema.pipelineStages.pipelineId, id))
  return mapPipeline(row, stages).toSnapshot()
}

export async function listEntries(tx: Transaction, kind: string, includeArchived: boolean) {
  const rows = await tx
    .select()
    .from(schema.listEntries)
    .where(
      and(
        eq(schema.listEntries.kind, kind),
        includeArchived ? undefined : eq(schema.listEntries.archived, false),
      ),
    )
    .orderBy(asc(schema.listEntries.name), asc(schema.listEntries.id))
  return rows.map((row) => mapListEntry(row).toSnapshot())
}

export interface OpportunityFilter {
  readonly pipelineId: string | null
  readonly stageId: string | null
  readonly status: string | null
  readonly ownerId: string | null
  readonly accountId: string | null
  readonly limit: number
  readonly offset: number
}

export async function listOpportunities(tx: Transaction, filter: OpportunityFilter) {
  const conditions = [
    filter.pipelineId ? eq(schema.opportunities.pipelineId, filter.pipelineId) : undefined,
    filter.stageId ? eq(schema.opportunities.stageId, filter.stageId) : undefined,
    filter.status ? eq(schema.opportunities.status, filter.status) : undefined,
    filter.ownerId ? eq(schema.opportunities.ownerId, filter.ownerId) : undefined,
    filter.accountId ? eq(schema.opportunities.accountId, filter.accountId) : undefined,
  ].filter((condition) => condition !== undefined)
  const where = conditions.length ? and(...conditions) : undefined
  const [rows, [total]] = await Promise.all([
    tx
      .select()
      .from(schema.opportunities)
      .where(where)
      .orderBy(asc(schema.opportunities.expectedCloseOn), desc(schema.opportunities.updatedAt))
      .limit(filter.limit)
      .offset(filter.offset),
    tx.select({ value: count() }).from(schema.opportunities).where(where),
  ])
  return { data: rows.map((row) => mapOpportunity(row).toSnapshot()), total: total?.value ?? 0 }
}

export async function opportunityDetail(tx: Transaction, id: string) {
  const [row] = await tx
    .select()
    .from(schema.opportunities)
    .where(eq(schema.opportunities.id, id))
    .limit(1)
  if (!row) return null
  const history = await tx
    .select()
    .from(schema.opportunityEvents)
    .where(eq(schema.opportunityEvents.opportunityId, id))
    .orderBy(asc(schema.opportunityEvents.sequence))
  const quotes = await tx
    .select()
    .from(schema.opportunityQuotes)
    .where(eq(schema.opportunityQuotes.opportunityId, id))
    .orderBy(asc(schema.opportunityQuotes.seenAt))
  return {
    opportunity: mapOpportunity(row).toSnapshot(),
    history: history.map(mapFact),
    quotes: quotes.map((quote) => ({
      quoteRoot: quote.quoteRoot,
      quoteId: quote.quoteId,
      quoteVersion: quote.quoteVersion,
      status: quote.status,
      total:
        quote.totalAmount === null || quote.currency === null
          ? null
          : { amount: quote.totalAmount.toString(), currency: quote.currency },
      seenAt: quote.seenAt,
    })),
  }
}
