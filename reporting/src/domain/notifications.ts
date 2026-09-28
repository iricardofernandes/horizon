/**
 * Notifications (Phase 66): what needs a person's attention, told once per fact. They live
 * in reporting as presentation state (ADR 0058 §4); the fact stays with its module.
 */

export const NOTIFICATION_KINDS = [
  'task-due',
  'approval-requisition',
  'approval-order',
  'approval-payable',
  'import-finished',
  'billing-run-finished',
  'file-quarantined',
  'export-finished',
  'reconciliation-different',
] as const

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]

/**
 * Who sees it: one user, or whoever holds one of the module's roles when they read it,
 * except the person whose own request it is (they cannot approve it themselves).
 */
export type Recipient =
  | { readonly type: 'user'; readonly userId: string }
  | {
      readonly type: 'role'
      readonly module: string
      readonly roles: readonly string[]
      readonly except: string | null
    }

/** Ids, counts and statuses only: the screen renders the words in the reader's language. */
export type NotificationParams = Readonly<Record<string, string | number | null>>

export interface NotificationDraft {
  readonly kind: NotificationKind
  /** The event, run or export it tells about; with the recipient, what makes it unique. */
  readonly sourceId: string
  readonly recipient: Recipient
  readonly params: NotificationParams
  readonly link: string | null
  readonly occurredAt: Date
}

export interface Notification extends NotificationDraft {
  readonly id: string
  readonly createdAt: Date
}

export interface Reader {
  readonly userId: string
  readonly roles: readonly { readonly module: string; readonly role: string }[]
}

/** The stored form of a recipient, part of the uniqueness key. */
export function recipientKey(recipient: Recipient): string {
  return recipient.type === 'user'
    ? `user:${recipient.userId}`
    : `role:${recipient.module}:${[...recipient.roles].sort().join(',')}`
}

export function canSee(recipient: Recipient, reader: Reader): boolean {
  if (recipient.type === 'user') return recipient.userId === reader.userId
  if (recipient.except === reader.userId) return false
  return reader.roles.some(
    (assignment) =>
      assignment.module === recipient.module && recipient.roles.includes(assignment.role),
  )
}
