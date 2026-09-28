import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NotificationIntake, NotificationsUseCase } from '@/application/notifications'
import { ManageViewsUseCase } from '@/application/views'
import { ReportingDatabase } from '@/infrastructure/database/drizzle/reporting-database'

/**
 * Notifications and saved views against real PostgreSQL (Phase 66): once per event however
 * often it is delivered, seen only by whom it is for, read per person, and kept per tenant.
 */
const clock = { now: () => new Date() }
let database: ReportingDatabase
let administrator: ReturnType<typeof postgres>
let intake: NotificationIntake
let bell: NotificationsUseCase
let views: ManageViewsUseCase

beforeAll(() => {
  database = new ReportingDatabase({ url: process.env.DATABASE_URL ?? '' })
  administrator = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
  intake = new NotificationIntake(database.notifications, clock)
  bell = new NotificationsUseCase(database.notifications, clock)
  views = new ManageViewsUseCase(database.views, clock)
})

afterAll(async () => {
  await Promise.allSettled([database?.close(), administrator?.end()])
})

function envelope(tenantId: string, eventType: string, payload: Record<string, unknown>) {
  return {
    eventId: randomUUID(),
    eventType,
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    tenantId,
    traceId: 'b'.repeat(32),
    payload,
  }
}

describe('notifications', () => {
  it('are made once per event, however often it is delivered', async () => {
    const tenantId = randomUUID()
    const assignee = randomUUID()
    const event = envelope(tenantId, 'crm.task.due', {
      taskId: randomUUID(),
      accountId: randomUUID(),
      subject: { type: 'account', id: randomUUID() },
      assigneeId: assignee,
      dueAt: new Date().toISOString(),
      remindAt: new Date().toISOString(),
    })
    const outcomes = [
      await intake.handle(event),
      await intake.handle(event),
      await intake.handle(event),
    ]
    expect(outcomes).toEqual(['notified', 'duplicate', 'duplicate'])
    const [row] =
      await administrator`select count(*)::int as n from notifications where tenant_id = ${tenantId}`
    expect(row?.n).toBe(1)
    expect(await bell.unread(tenantId, { userId: assignee, roles: [] })).toBe(1)
    await expect(
      administrator`update notifications set link = null where tenant_id = ${tenantId}`,
    ).rejects.toThrow(/append-only/)
  })

  it('reach the approving roles but not the requester, and are read per person', async () => {
    const tenantId = randomUUID()
    await intake.handle(
      envelope(tenantId, 'financial.payable.approval-requested', {
        titleId: randomUUID(),
        requestedBy: 'clerk',
        amount: { amount: '2500000', currency: 'BRL' },
      }),
    )
    const approver = { userId: 'controller', roles: [{ module: 'financial', role: 'admin' }] }
    const clerkAsAdmin = { userId: 'clerk', roles: [{ module: 'financial', role: 'admin' }] }
    const operator = { userId: 'operator', roles: [{ module: 'financial', role: 'operator' }] }
    const other = { userId: 'other-admin', roles: [{ module: 'financial', role: 'admin' }] }
    expect(await bell.unread(tenantId, approver)).toBe(1)
    expect(await bell.unread(tenantId, clerkAsAdmin)).toBe(0)
    expect(await bell.unread(tenantId, operator)).toBe(0)
    const [notification] = await bell.list(tenantId, approver)
    expect(notification).toMatchObject({ kind: 'approval-payable', link: '/app/finance/payables' })
    expect(await bell.markRead(tenantId, approver, notification?.id ?? '')).toBe(1)
    expect(await bell.markRead(tenantId, approver, notification?.id ?? '')).toBe(0)
    expect(await bell.unread(tenantId, approver)).toBe(0)
    expect(await bell.unread(tenantId, other)).toBe(1)
    expect(await bell.markRead(tenantId, operator, notification?.id ?? '')).toBe(0)
    expect(await bell.list(randomUUID(), approver)).toEqual([])
  })
})

describe('saved views', () => {
  it('are kept per tenant, shared by their owner, and changed only by them', async () => {
    const tenantId = randomUUID()
    const created = await views.create(tenantId, 'ana', {
      screen: 'catalog.items',
      name: 'Cafés',
      query: 'search=caf',
      columns: null,
      shared: true,
    })
    if (created.isLeft()) throw created.value
    expect((await views.list(tenantId, 'bruno', 'catalog.items')).map((v) => v.name)).toEqual([
      'Cafés',
    ])
    expect(await views.list(randomUUID(), 'ana', null)).toEqual([])
    const refused = await views.remove(tenantId, 'bruno', created.value.viewId)
    expect(refused.isLeft() && refused.value.title).toBe('Forbidden')
    const updated = await views.update(tenantId, 'ana', created.value.viewId, { shared: false })
    expect(updated.isRight()).toBe(true)
    expect(await views.list(tenantId, 'bruno', null)).toEqual([])
    expect((await views.remove(tenantId, 'ana', created.value.viewId)).isRight()).toBe(true)
  })
})
