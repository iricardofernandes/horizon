import { z } from 'zod'

import { uuidSchema } from '../common'
import {
  ATTACHING_MODULES,
  ATTACHMENT_CONTENT_TYPES,
  ATTACHMENT_DELETION_REASONS,
  ATTACHMENT_MAX_BYTES,
  type AttachingModule,
} from '../http/files'
import { defineEvent } from './define'

/**
 * Attachment facts (ADR 0060). They name the record and never the file: a file name is
 * personal data as often as not, so it stays in `files`.
 */
const reference = {
  attachmentId: uuidSchema,
  module: z.enum(ATTACHING_MODULES as [AttachingModule, ...AttachingModule[]]),
  recordType: z.string().regex(/^[a-z][a-z-]*$/),
  recordId: uuidSchema,
}

export const filesAttachmentAvailable = defineEvent({
  type: 'files.attachment.available',
  version: 1,
  description:
    'A file attached to a record passed its scan and can be downloaded by whoever reads the record.',
  payload: z.strictObject({
    ...reference,
    contentType: z.enum(ATTACHMENT_CONTENT_TYPES),
    size: z.number().int().positive().max(ATTACHMENT_MAX_BYTES),
  }),
})

export const filesAttachmentQuarantined = defineEvent({
  type: 'files.attachment.quarantined',
  version: 1,
  description:
    'The scanner found something in a file attached to a record. Its bytes were removed and it is never served.',
  payload: z.strictObject({
    ...reference,
    /** Who uploaded it, so they can be told (Phase 66); added in 0.49.0. */
    uploadedBy: z.string().min(1).max(255).optional(),
  }),
})

export const filesAttachmentDeleted = defineEvent({
  type: 'files.attachment.deleted',
  version: 1,
  description:
    'An attachment ended: removed by a person, expired by retention, shredded with its owner, or never uploaded.',
  payload: z.strictObject({
    ...reference,
    reason: z.enum(ATTACHMENT_DELETION_REASONS),
  }),
})
