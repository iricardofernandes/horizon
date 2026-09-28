import { z } from 'zod'

import { instantSchema, uuidSchema } from '../common'

/**
 * Attachments (ADR 0060, Phase 65). `files` holds no roles of its own: whoever holds the
 * owning module's read or write role reads or attaches, so a record is named by its
 * module, its type and its id.
 */

/** `uploading → scanning → available | quarantined → deleted`. Only `available` is served. */
export const ATTACHMENT_STATES = [
  'uploading',
  'scanning',
  'available',
  'quarantined',
  'deleted',
] as const

/** Why an attachment ended: a person, retention, its owner's erasure, the scanner, or no bytes. */
export const ATTACHMENT_DELETION_REASONS = [
  'removed',
  'expired',
  'erased',
  'quarantined',
  'abandoned',
] as const

/** The records that take attachments, per owning module. */
export const ATTACHABLE_RECORDS = {
  parties: ['party'],
  procurement: ['purchase-order'],
  financial: ['receivable', 'payable'],
  sales: ['service-order'],
  crm: ['opportunity'],
} as const

export type AttachingModule = keyof typeof ATTACHABLE_RECORDS
export const ATTACHING_MODULES = Object.keys(ATTACHABLE_RECORDS) as AttachingModule[]
export type AttachableRecordType = (typeof ATTACHABLE_RECORDS)[AttachingModule][number]

/**
 * What may be attached. Nothing a browser would run (HTML, SVG, scripts) is on it, and
 * `files` checks the first bytes against the declared type before storing anything.
 */
export const ATTACHMENT_CONTENT_TYPES = [
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

/** 10 MiB per file. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024

const recordReference = {
  module: z.enum(ATTACHING_MODULES as [AttachingModule, ...AttachingModule[]]),
  recordType: z.string().regex(/^[a-z][a-z-]*$/),
  recordId: uuidSchema,
}

function attachable(value: { module: AttachingModule; recordType: string }): boolean {
  return (ATTACHABLE_RECORDS[value.module] as readonly string[]).includes(value.recordType)
}

const notAttachable = { message: 'this module does not take attachments on that record type' }

/** Asking for an upload slot. The bytes follow to the signed link it answers. */
export const attachmentRequestSchema = z
  .object({
    ...recordReference,
    fileName: z
      .string()
      .min(1)
      .max(255)
      .refine((name) => !/[\\/\p{Cc}]/u.test(name), 'must be a name, not a path'),
    contentType: z.enum(ATTACHMENT_CONTENT_TYPES),
    size: z.number().int().positive().max(ATTACHMENT_MAX_BYTES),
    /** The party the file is about, when the record has one: its erasure shreds the file. */
    ownerPartyId: uuidSchema.optional(),
  })
  .strict()
  .refine(attachable, notAttachable)

export const attachmentSchema = z
  .object({
    id: uuidSchema,
    ...recordReference,
    fileName: z.string().min(1).max(255),
    contentType: z.enum(ATTACHMENT_CONTENT_TYPES),
    size: z.number().int().positive().max(ATTACHMENT_MAX_BYTES),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    status: z.enum(ATTACHMENT_STATES),
    deletionReason: z.enum(ATTACHMENT_DELETION_REASONS).nullable(),
    /** The scanner's name for what it found, only when quarantined. */
    finding: z.string().max(200).nullable(),
    uploadedBy: z.string().min(1),
    createdAt: instantSchema,
    availableAt: instantSchema.nullable(),
    /** When retention removes it; null while it has no end. */
    expiresAt: instantSchema.nullable(),
  })
  .strict()
  .refine(attachable, notAttachable)

/** A signed, short-lived link: an upload slot (`PUT`) or a download (`GET`). */
export const attachmentLinkSchema = z
  .object({
    method: z.enum(['PUT', 'GET']),
    url: z.string().startsWith('/files/'),
    expiresAt: instantSchema,
  })
  .strict()

export type AttachmentState = (typeof ATTACHMENT_STATES)[number]
export type AttachmentDeletionReason = (typeof ATTACHMENT_DELETION_REASONS)[number]
export type AttachmentContentType = (typeof ATTACHMENT_CONTENT_TYPES)[number]
export type AttachmentRequest = z.infer<typeof attachmentRequestSchema>
export type Attachment = z.infer<typeof attachmentSchema>
export type AttachmentLink = z.infer<typeof attachmentLinkSchema>
