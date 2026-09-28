/**
 * The words of attachments, as the domain holds them. `@horizon/contracts` publishes the
 * same lists (`http/files.ts`); a test keeps the two equal, and the domain free of the
 * package (ADR 0002).
 */

export const ATTACHABLE_RECORDS = {
  parties: ['party'],
  procurement: ['purchase-order'],
  financial: ['receivable', 'payable'],
  sales: ['service-order'],
  crm: ['opportunity'],
} as const

export type AttachingModule = keyof typeof ATTACHABLE_RECORDS

export const ATTACHMENT_STATES = [
  'uploading',
  'scanning',
  'available',
  'quarantined',
  'deleted',
] as const
export type AttachmentState = (typeof ATTACHMENT_STATES)[number]

export const DELETION_REASONS = [
  'removed',
  'expired',
  'erased',
  'quarantined',
  'abandoned',
] as const
export type DeletionReason = (typeof DELETION_REASONS)[number]

export const CONTENT_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const
export type ContentType = (typeof CONTENT_TYPES)[number]
