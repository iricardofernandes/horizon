import { and, asc, count, eq, ilike, or, type SQL, sql } from 'drizzle-orm'
import type { AccountSnapshot } from '@/domain/entities/account'
import type { ContactSnapshot } from '@/domain/entities/contact'
import { type ContactSealer, mapAccount, type Transaction } from './crm-store'
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
