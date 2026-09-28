import { type EventEnvelope, eventEnvelopeSchema, findEvent } from '@horizon/contracts'
import type { Notification, NotificationDraft, Reader, Recipient } from '@/domain/notifications'
import { Undeliverable } from './journal-intake'
import type { Clock } from './ports/journal-store'

/** A notification as a reader sees it, with whether they read it. */
export interface ReadNotification extends Notification {
  readonly readAt: Date | null
}

/** Where notifications are kept, once per source and recipient. */
export abstract class NotificationStore {
  /** Inserts what is new; answers how many were. A repeated source inserts nothing. */
  abstract insert(
    tenantId: string,
    drafts: readonly NotificationDraft[],
    now: Date,
  ): Promise<number>
  abstract listFor(tenantId: string, reader: Reader, limit: number): Promise<ReadNotification[]>
  abstract unreadCount(tenantId: string, reader: Reader): Promise<number>
  /** Marks read what the reader can see: one notification, or all of them. */
  abstract markRead(tenantId: string, reader: Reader, id: string | null, now: Date): Promise<number>
}

const count = (value: unknown) => (typeof value === 'number' ? value : 0)
const text = (value: unknown) => (typeof value === 'string' ? value : null)
const user = (userId: unknown): Recipient | null =>
  typeof userId === 'string' && userId.length > 0 ? { type: 'user', userId } : null
const approvers = (module: string, roles: string[], except: unknown): Recipient => ({
  type: 'role',
  module,
  roles,
  except: text(except),
})

type Mapped = Omit<NotificationDraft, 'sourceId' | 'occurredAt'>
type Mapper = (payload: Record<string, unknown>) => Mapped | null

const importFinished =
  (module: string): Mapper =>
  (payload) => {
    const recipient = user(payload.requestedBy)
    return recipient
      ? {
          kind: 'import-finished',
          recipient,
          params: {
            module,
            jobId: text(payload.jobId),
            kind: text(payload.kind),
            status: text(payload.status),
            total: count(payload.total),
            written: count(payload.written),
            failed: count(payload.failed),
          },
          link: `/app/administration/imports?module=${module}&job=${String(payload.jobId)}`,
        }
      : null
  }

/**
 * The events that notify, and whom (Phase 66). An approval goes to the roles that can give
 * it, never to whoever asked; everything else to the one person it concerns.
 */
const MAPPERS: Readonly<Record<string, Mapper>> = {
  'crm.task.due': (payload) => {
    const recipient = user(payload.assigneeId)
    const subject = payload.subject as { type?: unknown; id?: unknown } | undefined
    return recipient
      ? {
          kind: 'task-due',
          recipient,
          params: {
            taskId: text(payload.taskId),
            subjectType: text(subject?.type),
            subjectId: text(subject?.id),
            dueAt: text(payload.dueAt),
          },
          link: '/app/crm/agenda',
        }
      : null
  },
  'procurement.requisition.submitted': (payload) => ({
    kind: 'approval-requisition',
    recipient: approvers('procurement', ['admin', 'approver'], payload.submittedBy),
    params: { requisitionId: text(payload.requisitionId) },
    link: '/app/purchasing',
  }),
  'procurement.order.placed': (payload) =>
    payload.approvalRequired === true
      ? {
          kind: 'approval-order',
          recipient: approvers('procurement', ['admin', 'approver'], payload.placedBy),
          params: { orderId: text(payload.orderId) },
          link: '/app/purchasing',
        }
      : null,
  'financial.payable.approval-requested': (payload) => {
    const amount = payload.amount as { amount?: unknown; currency?: unknown } | undefined
    return {
      kind: 'approval-payable',
      recipient: approvers('financial', ['admin'], payload.requestedBy),
      params: {
        titleId: text(payload.titleId),
        amount: text(amount?.amount),
        currency: text(amount?.currency),
      },
      link: '/app/finance/payables',
    }
  },
  'parties.import.finished': importFinished('parties'),
  'catalog.import.finished': importFinished('catalog'),
  'inventory.import.finished': importFinished('inventory'),
  'financial.import.finished': importFinished('financial'),
  'sales.billing-run.finished': (payload) => {
    const recipient = user(payload.startedBy)
    return recipient
      ? {
          kind: 'billing-run-finished',
          recipient,
          params: {
            runId: text(payload.runId),
            competence: text(payload.competence),
            billed: count(payload.billed),
            skipped: count(payload.skipped),
            refused: count(payload.refused),
          },
          link: '/app/sales/billing',
        }
      : null
  },
  'files.attachment.quarantined': (payload) => {
    const recipient = user(payload.uploadedBy)
    return recipient
      ? {
          kind: 'file-quarantined',
          recipient,
          params: {
            attachmentId: text(payload.attachmentId),
            module: text(payload.module),
            recordType: text(payload.recordType),
            recordId: text(payload.recordId),
          },
          link: null,
        }
      : null
  },
}

/** What the notifications queue is bound to. */
export const NOTIFYING_EVENT_TYPES: readonly string[] = Object.keys(MAPPERS).sort()

/** The notification an event makes, if it makes one. Exported for tests. */
export function draftOf(event: EventEnvelope): NotificationDraft | null {
  const mapped = MAPPERS[event.eventType]?.(event.payload as Record<string, unknown>)
  return mapped
    ? { ...mapped, sourceId: event.eventId, occurredAt: new Date(event.occurredAt) }
    : null
}

function envelopeOf(body: unknown): EventEnvelope {
  const parsed = eventEnvelopeSchema.safeParse(body)
  if (!parsed.success) throw new Undeliverable('not an event envelope')
  const definition = findEvent(parsed.data.eventType, parsed.data.eventVersion)
  if (!definition?.payload.safeParse(parsed.data.payload).success)
    throw new Undeliverable('unknown event, or a payload that does not match its contract')
  return parsed.data
}

/**
 * The notifications queue (Phase 66). A delivered event makes at most one notification per
 * recipient: a redelivery, or the same event published again, finds it already there.
 * Replays of history go to the journal's replay queue and never reach here.
 */
export class NotificationIntake {
  constructor(
    private readonly store: NotificationStore,
    private readonly clock: Clock,
  ) {}

  async handle(body: unknown): Promise<'notified' | 'duplicate' | 'ignored'> {
    const event = envelopeOf(body)
    const draft = draftOf(event)
    if (!draft) return 'ignored'
    const inserted = await this.store.insert(event.tenantId, [draft], this.clock.now())
    return inserted > 0 ? 'notified' : 'duplicate'
  }
}

/** A reader's bell. Anyone signed in reads their own; no Reporting role is needed. */
export class NotificationsUseCase {
  constructor(
    private readonly store: NotificationStore,
    private readonly clock: Clock,
  ) {}

  list(tenantId: string, reader: Reader, limit = 50) {
    return this.store.listFor(tenantId, reader, Math.min(Math.max(limit, 1), 100))
  }

  unread(tenantId: string, reader: Reader) {
    return this.store.unreadCount(tenantId, reader)
  }

  markRead(tenantId: string, reader: Reader, id: string) {
    return this.store.markRead(tenantId, reader, id, this.clock.now())
  }

  markAllRead(tenantId: string, reader: Reader) {
    return this.store.markRead(tenantId, reader, null, this.clock.now())
  }
}
