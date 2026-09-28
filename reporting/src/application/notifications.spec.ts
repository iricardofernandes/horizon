import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { canSee, type Reader, recipientKey } from '@/domain/notifications'
import { Undeliverable } from './journal-intake'
import {
  draftOf,
  NOTIFYING_EVENT_TYPES,
  NotificationIntake,
  NotificationStore,
  NotificationsUseCase,
  type ReadNotification,
} from './notifications'

const tenantId = randomUUID()
const clock = { now: () => new Date('2026-09-28T12:00:00.000Z') }

function envelope(eventType: string, payload: Record<string, unknown>, eventId = randomUUID()) {
  return {
    eventId,
    eventType,
    eventVersion: 1,
    occurredAt: '2026-09-28T11:59:00.000Z',
    tenantId,
    traceId: 'a'.repeat(32),
    payload,
  }
}

/** Keeps notifications once per source and recipient, as the table's key does. */
class MemoryNotifications extends NotificationStore {
  readonly held: ReadNotification[] = []
  readonly reads = new Set<string>()
  async insert(_: string, drafts: readonly import('@/domain/notifications').NotificationDraft[]) {
    let inserted = 0
    for (const draft of drafts) {
      const key = `${draft.sourceId}|${draft.kind}|${recipientKey(draft.recipient)}`
      if (this.held.some((n) => `${n.sourceId}|${n.kind}|${recipientKey(n.recipient)}` === key))
        continue
      this.held.push({ ...draft, id: randomUUID(), createdAt: clock.now(), readAt: null })
      inserted += 1
    }
    return inserted
  }
  async listFor(_: string, reader: Reader) {
    return this.held
      .filter((n) => canSee(n.recipient, reader))
      .map((n) => ({
        ...n,
        readAt: this.reads.has(`${n.id}|${reader.userId}`) ? clock.now() : null,
      }))
  }
  async unreadCount(tenant: string, reader: Reader) {
    return (await this.listFor(tenant, reader)).filter((n) => n.readAt === null).length
  }
  async markRead(tenant: string, reader: Reader, id: string | null) {
    const visible = (await this.listFor(tenant, reader)).filter((n) => id === null || n.id === id)
    for (const n of visible) this.reads.add(`${n.id}|${reader.userId}`)
    return visible.length
  }
}

const assignee = randomUUID()
const taskDue = {
  taskId: randomUUID(),
  accountId: randomUUID(),
  subject: { type: 'opportunity', id: randomUUID() },
  assigneeId: assignee,
  dueAt: '2026-09-28T13:00:00.000Z',
  remindAt: '2026-09-28T12:00:00.000Z',
}

describe('which events notify, and whom', () => {
  it('tells an assignee, a requester or an uploader, and nobody for the rest', () => {
    expect(NOTIFYING_EVENT_TYPES).toContain('crm.task.due')
    const due = draftOf(envelope('crm.task.due', taskDue) as never)
    expect(due).toMatchObject({ kind: 'task-due', recipient: { type: 'user', userId: assignee } })
    const imported = draftOf(
      envelope('catalog.import.finished', {
        jobId: randomUUID(),
        kind: 'items',
        status: 'completed',
        requestedBy: 'u-1',
        total: 3,
        written: 3,
        failed: 0,
        cancelled: 0,
      }) as never,
    )
    expect(imported?.params).toMatchObject({ module: 'catalog', written: 3 })
    const unnamed = draftOf(
      envelope('files.attachment.quarantined', {
        attachmentId: randomUUID(),
        module: 'crm',
        recordType: 'opportunity',
        recordId: randomUUID(),
      }) as never,
    )
    expect(unnamed).toBeNull()
  })

  it('sends an approval to the roles that give it, never to whoever asked', () => {
    const placed = draftOf(
      envelope('procurement.order.placed', {
        orderId: randomUUID(),
        placedBy: 'buyer-1',
        approvalRequired: true,
      }) as never,
    )
    expect(placed?.recipient).toEqual({
      type: 'role',
      module: 'procurement',
      roles: ['admin', 'approver'],
      except: 'buyer-1',
    })
    expect(
      draftOf(
        envelope('procurement.order.placed', {
          orderId: randomUUID(),
          placedBy: 'b',
          approvalRequired: false,
        }) as never,
      ),
    ).toBeNull()
    const approver: Reader = {
      userId: 'approver-1',
      roles: [{ module: 'procurement', role: 'approver' }],
    }
    const buyerWhoIsAdmin: Reader = {
      userId: 'buyer-1',
      roles: [{ module: 'procurement', role: 'admin' }],
    }
    const viewer: Reader = {
      userId: 'viewer-1',
      roles: [{ module: 'procurement', role: 'viewer' }],
    }
    const recipient = placed?.recipient ?? { type: 'user', userId: '' }
    expect([approver, buyerWhoIsAdmin, viewer].map((reader) => canSee(recipient, reader))).toEqual([
      true,
      false,
      false,
    ])
  })
})

describe('the notifications queue', () => {
  it('makes one notification per event, however often it is delivered', async () => {
    const store = new MemoryNotifications()
    const intake = new NotificationIntake(store, clock)
    const event = envelope('crm.task.due', taskDue)
    expect(await intake.handle(event)).toBe('notified')
    expect(await intake.handle(event)).toBe('duplicate')
    expect(store.held).toHaveLength(1)
  })

  it('dead-letters what is not an event of a known contract', async () => {
    const intake = new NotificationIntake(new MemoryNotifications(), clock)
    await expect(intake.handle({ nope: true })).rejects.toBeInstanceOf(Undeliverable)
    await expect(
      intake.handle(envelope('crm.task.due', { ...taskDue, assigneeId: 'not-a-uuid' })),
    ).rejects.toBeInstanceOf(Undeliverable)
  })
})

describe('the bell', () => {
  it('counts what is unread per person, and marks one or all read', async () => {
    const store = new MemoryNotifications()
    const intake = new NotificationIntake(store, clock)
    const redelivered = envelope('crm.task.due', taskDue)
    await intake.handle(redelivered)
    await intake.handle(redelivered)
    await intake.handle(envelope('crm.task.due', { ...taskDue, taskId: randomUUID() }))
    const bell = new NotificationsUseCase(store, clock)
    const reader: Reader = { userId: assignee, roles: [] }
    expect(await bell.unread(tenantId, reader)).toBe(2)
    const [first] = await bell.list(tenantId, reader, 500)
    await bell.markRead(tenantId, reader, first?.id ?? '')
    expect(await bell.unread(tenantId, reader)).toBe(1)
    await bell.markAllRead(tenantId, reader)
    expect(await bell.unread(tenantId, reader)).toBe(0)
    expect(await bell.unread(tenantId, { userId: 'someone-else', roles: [] })).toBe(0)
  })
})
