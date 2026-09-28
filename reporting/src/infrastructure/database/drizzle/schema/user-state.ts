import { boolean, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'

const instant = (name: string) => timestamp(name, { withTimezone: true })

export const savedViews = pgTable('saved_views', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  screen: text('screen').notNull(),
  name: text('name').notNull(),
  query: text('query').notNull(),
  columns: jsonb('columns'),
  ownerId: text('owner_id').notNull(),
  shared: boolean('shared').notNull(),
  createdAt: instant('created_at').notNull(),
  updatedAt: instant('updated_at').notNull(),
})

export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  kind: text('kind').notNull(),
  sourceId: text('source_id').notNull(),
  recipient: text('recipient').notNull(),
  recipientUser: text('recipient_user'),
  recipientModule: text('recipient_module'),
  recipientRoles: text('recipient_roles').array(),
  exceptUser: text('except_user'),
  params: jsonb('params').notNull(),
  link: text('link'),
  occurredAt: instant('occurred_at').notNull(),
  createdAt: instant('created_at').notNull(),
})

export const notificationReads = pgTable(
  'notification_reads',
  {
    tenantId: uuid('tenant_id').notNull(),
    notificationId: uuid('notification_id').notNull(),
    userId: text('user_id').notNull(),
    readAt: instant('read_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.notificationId, table.userId] })],
)
