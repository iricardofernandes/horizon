import { and, desc, eq, isNotNull, isNull, ne, or, type SQL, sql } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import { NotificationStore, type ReadNotification } from '@/application/notifications'
import { ViewStore } from '@/application/views'
import {
  type NotificationDraft,
  type NotificationKind,
  type Reader,
  type Recipient,
  recipientKey,
} from '@/domain/notifications'
import type { SavedView } from '@/domain/views'
import * as schema from './schema'
import type { Transaction } from './transaction'

type Within = <T>(tenantId: string, work: (tx: Transaction) => Promise<T>) => Promise<T>

const table = schema.notifications

/** Inserts what is new; a notification already told for the same source and recipient is kept. */
export async function insertNotifications(
  tx: Transaction,
  tenantId: string,
  drafts: readonly NotificationDraft[],
  now: Date,
): Promise<number> {
  if (drafts.length === 0) return 0
  const inserted = await tx
    .insert(table)
    .values(
      drafts.map((draft) => ({
        id: uuidv7(),
        tenantId,
        kind: draft.kind,
        sourceId: draft.sourceId,
        recipient: recipientKey(draft.recipient),
        recipientUser: draft.recipient.type === 'user' ? draft.recipient.userId : null,
        recipientModule: draft.recipient.type === 'role' ? draft.recipient.module : null,
        recipientRoles: draft.recipient.type === 'role' ? [...draft.recipient.roles] : null,
        exceptUser: draft.recipient.type === 'role' ? draft.recipient.except : null,
        params: { ...draft.params },
        link: draft.link,
        occurredAt: draft.occurredAt,
        createdAt: now,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: table.id })
  return inserted.length
}

/** What the reader can see: addressed to them, or to a role they hold and not their own ask. */
function visibleTo(reader: Reader): SQL {
  const byRole = reader.roles.map(({ module, role }) =>
    and(eq(table.recipientModule, module), sql`${role} = any(${table.recipientRoles})`),
  )
  const roleBranch =
    byRole.length === 0
      ? sql`false`
      : and(
          isNotNull(table.recipientModule),
          or(isNull(table.exceptUser), ne(table.exceptUser, reader.userId)),
          or(...byRole),
        )
  return or(eq(table.recipientUser, reader.userId), roleBranch) ?? sql`false`
}

function recipientOf(row: typeof table.$inferSelect): Recipient {
  return row.recipientUser !== null
    ? { type: 'user', userId: row.recipientUser }
    : {
        type: 'role',
        module: row.recipientModule ?? '',
        roles: row.recipientRoles ?? [],
        except: row.exceptUser,
      }
}

export class SqlNotificationStore extends NotificationStore {
  constructor(private readonly within: Within) {
    super()
  }

  insert(tenantId: string, drafts: readonly NotificationDraft[], now: Date) {
    return this.within(tenantId, (tx) => insertNotifications(tx, tenantId, drafts, now))
  }

  listFor(tenantId: string, reader: Reader, limit: number): Promise<ReadNotification[]> {
    return this.within(tenantId, async (tx) => {
      const reads = schema.notificationReads
      const rows = await tx
        .select({ notification: table, readAt: reads.readAt })
        .from(table)
        .leftJoin(reads, and(eq(reads.notificationId, table.id), eq(reads.userId, reader.userId)))
        .where(visibleTo(reader))
        .orderBy(desc(table.createdAt))
        .limit(limit)
      return rows.map(({ notification, readAt }) => ({
        id: notification.id,
        kind: notification.kind as NotificationKind,
        sourceId: notification.sourceId,
        recipient: recipientOf(notification),
        params: notification.params as Record<string, string | number | null>,
        link: notification.link,
        occurredAt: notification.occurredAt,
        createdAt: notification.createdAt,
        readAt,
      }))
    })
  }

  unreadCount(tenantId: string, reader: Reader): Promise<number> {
    return this.within(tenantId, async (tx) => {
      const reads = schema.notificationReads
      const [row] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(table)
        .leftJoin(reads, and(eq(reads.notificationId, table.id), eq(reads.userId, reader.userId)))
        .where(and(visibleTo(reader), isNull(reads.readAt)))
      return row?.count ?? 0
    })
  }

  markRead(tenantId: string, reader: Reader, id: string | null, now: Date): Promise<number> {
    return this.within(tenantId, async (tx) => {
      const visible = await tx
        .select({ id: table.id })
        .from(table)
        .where(id === null ? visibleTo(reader) : and(eq(table.id, id), visibleTo(reader)))
      if (visible.length === 0) return 0
      const marked = await tx
        .insert(schema.notificationReads)
        .values(
          visible.map((row) => ({
            tenantId,
            notificationId: row.id,
            userId: reader.userId,
            readAt: now,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: schema.notificationReads.notificationId })
      return marked.length
    })
  }
}

function viewOf(row: typeof schema.savedViews.$inferSelect): SavedView {
  return {
    viewId: row.id,
    screen: row.screen,
    name: row.name,
    query: row.query,
    columns: (row.columns as string[] | null) ?? null,
    ownerId: row.ownerId,
    shared: row.shared,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export class SqlViewStore extends ViewStore {
  constructor(private readonly within: Within) {
    super()
  }

  list(tenantId: string, userId: string, screen: string | null): Promise<SavedView[]> {
    return this.within(tenantId, async (tx) => {
      const views = schema.savedViews
      const visible = or(eq(views.ownerId, userId), eq(views.shared, true))
      const rows = await tx
        .select()
        .from(views)
        .where(screen ? and(visible, eq(views.screen, screen)) : visible)
        .orderBy(views.screen, views.name)
      return rows.map(viewOf)
    })
  }

  find(tenantId: string, viewId: string): Promise<SavedView | null> {
    return this.within(tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.savedViews)
        .where(eq(schema.savedViews.id, viewId))
      return row ? viewOf(row) : null
    })
  }

  insert(tenantId: string, view: SavedView): Promise<void> {
    return this.within(tenantId, async (tx) => {
      await tx.insert(schema.savedViews).values({
        id: view.viewId,
        tenantId,
        screen: view.screen,
        name: view.name,
        query: view.query,
        columns: view.columns ? [...view.columns] : null,
        ownerId: view.ownerId,
        shared: view.shared,
        createdAt: view.createdAt,
        updatedAt: view.updatedAt,
      })
    })
  }

  update(tenantId: string, view: SavedView): Promise<void> {
    return this.within(tenantId, async (tx) => {
      await tx
        .update(schema.savedViews)
        .set({
          name: view.name,
          query: view.query,
          columns: view.columns ? [...view.columns] : null,
          shared: view.shared,
          updatedAt: view.updatedAt,
        })
        .where(eq(schema.savedViews.id, view.viewId))
    })
  }

  remove(tenantId: string, viewId: string): Promise<void> {
    return this.within(tenantId, async (tx) => {
      await tx.delete(schema.savedViews).where(eq(schema.savedViews.id, viewId))
    })
  }
}
