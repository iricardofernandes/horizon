import { DAY_MS, expiryOf, QUARANTINE_KEPT_DAYS, type RecordReference } from './records'
import type { AttachmentState, ContentType, DeletionReason } from './vocabulary'

export type OwnerType = 'party' | 'user'

/** Whose key encrypts the file: its erasure shreds it (ADR 0060). */
export interface Owner {
  readonly type: OwnerType
  readonly id: string
}

/**
 * One attachment, as stored. Every transition returns a new value; the store writes it
 * only if the row is still in the state the transition started from.
 *
 * `dueAt` is when the worker must look at the row next: the slot's end, the next scan, the
 * retention end, the quarantine end, or now, when bytes are to be removed.
 */
export interface Attachment extends RecordReference {
  readonly id: string
  readonly fileName: string
  readonly contentType: ContentType
  readonly size: number
  readonly sha256: string | null
  readonly status: AttachmentState
  readonly deletionReason: DeletionReason | null
  readonly finding: string | null
  readonly owner: Owner
  readonly wrappedDataKey: string | null
  readonly objectKey: string | null
  readonly idempotencyKey: string
  readonly fingerprint: string
  readonly uploadedBy: string
  readonly createdAt: Date
  readonly uploadedAt: Date | null
  readonly availableAt: Date | null
  readonly expiresAt: Date | null
  readonly deletedAt: Date | null
  readonly dueAt: Date | null
  readonly scanAttempts: number
}

/** A slot not used within this long is abandoned. */
export const UPLOAD_WINDOW_MS = 60 * 60 * 1000

export class TransitionRefused extends Error {
  constructor(
    readonly from: AttachmentState,
    readonly to: string,
  ) {
    super(`An attachment that is ${from} cannot become ${to}`)
    this.name = 'TransitionRefused'
  }
}

function from(attachment: Attachment, allowed: readonly AttachmentState[], to: string): void {
  if (!allowed.includes(attachment.status)) throw new TransitionRefused(attachment.status, to)
}

export function slotOf(input: {
  id: string
  record: RecordReference
  fileName: string
  contentType: ContentType
  size: number
  owner: Owner
  idempotencyKey: string
  fingerprint: string
  uploadedBy: string
  now: Date
}): Attachment {
  return {
    id: input.id,
    module: input.record.module,
    recordType: input.record.recordType,
    recordId: input.record.recordId,
    fileName: input.fileName,
    contentType: input.contentType,
    size: input.size,
    sha256: null,
    status: 'uploading',
    deletionReason: null,
    finding: null,
    owner: input.owner,
    wrappedDataKey: null,
    objectKey: null,
    idempotencyKey: input.idempotencyKey,
    fingerprint: input.fingerprint,
    uploadedBy: input.uploadedBy,
    createdAt: input.now,
    uploadedAt: null,
    availableAt: null,
    expiresAt: null,
    deletedAt: null,
    dueAt: new Date(input.now.getTime() + UPLOAD_WINDOW_MS),
    scanAttempts: 0,
  }
}

/** Whether the slot still takes bytes. */
export function acceptsBytes(attachment: Attachment, now: Date): boolean {
  return (
    attachment.status === 'uploading' &&
    now.getTime() < attachment.createdAt.getTime() + UPLOAD_WINDOW_MS
  )
}

/** The bytes are stored, encrypted; the scan has not answered. */
export function stored(
  attachment: Attachment,
  input: { sha256: string; wrappedDataKey: string; objectKey: string; now: Date; retryMs: number },
): Attachment {
  from(attachment, ['uploading'], 'scanning')
  return {
    ...attachment,
    status: 'scanning',
    sha256: input.sha256,
    wrappedDataKey: input.wrappedDataKey,
    objectKey: input.objectKey,
    uploadedAt: input.now,
    dueAt: new Date(input.now.getTime() + input.retryMs),
  }
}

export function scanFailed(attachment: Attachment, now: Date, retryMs: number): Attachment {
  from(attachment, ['scanning'], 'scanning')
  return {
    ...attachment,
    scanAttempts: attachment.scanAttempts + 1,
    dueAt: new Date(now.getTime() + retryMs),
  }
}

export function released(attachment: Attachment, now: Date): Attachment {
  from(attachment, ['scanning'], 'available')
  const expiresAt = expiryOf(attachment, now)
  return {
    ...attachment,
    status: 'available',
    availableAt: now,
    expiresAt,
    dueAt: expiresAt,
    scanAttempts: attachment.scanAttempts + 1,
  }
}

/** Found by the scanner: the bytes go at once, the row with its finding after 30 days. */
export function quarantined(attachment: Attachment, finding: string, now: Date): Attachment {
  from(attachment, ['scanning'], 'quarantined')
  return {
    ...attachment,
    status: 'quarantined',
    finding: finding.slice(0, 200),
    expiresAt: new Date(now.getTime() + QUARANTINE_KEPT_DAYS * DAY_MS),
    dueAt: now,
    scanAttempts: attachment.scanAttempts + 1,
  }
}

/**
 * Ended. Bytes still stored make the row due now, so the worker removes them and logs it.
 */
export function deleted(attachment: Attachment, reason: DeletionReason, now: Date): Attachment {
  if (attachment.status === 'deleted') throw new TransitionRefused('deleted', 'deleted')
  return {
    ...attachment,
    status: 'deleted',
    deletionReason: reason,
    deletedAt: now,
    dueAt: attachment.objectKey ? now : null,
  }
}

/** Its bytes were removed from storage. */
export function purged(attachment: Attachment): Attachment {
  const dueAt = attachment.status === 'quarantined' ? attachment.expiresAt : null
  return { ...attachment, objectKey: null, dueAt }
}

/** What the worker must do with a row that is due. */
export type DueWork = 'abandon' | 'scan' | 'expire' | 'purge' | 'end-quarantine' | 'none'

export function dueWorkOf(attachment: Attachment): DueWork {
  if (attachment.objectKey && ['quarantined', 'deleted'].includes(attachment.status)) return 'purge'
  switch (attachment.status) {
    case 'uploading':
      return 'abandon'
    case 'scanning':
      return 'scan'
    case 'available':
      return 'expire'
    case 'quarantined':
      return 'end-quarantine'
    case 'deleted':
      return 'none'
  }
}
