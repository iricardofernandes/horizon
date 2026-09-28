import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  filesAttachmentAvailable,
  filesAttachmentDeleted,
  filesAttachmentQuarantined,
} from '../events/files'
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_STATES,
  attachmentLinkSchema,
  attachmentRequestSchema,
  attachmentSchema,
} from './files'

const request = {
  module: 'financial',
  recordType: 'payable',
  recordId: randomUUID(),
  fileName: 'boleto-setembro.pdf',
  contentType: 'application/pdf',
  size: 48_213,
}

const attachment = {
  id: randomUUID(),
  module: 'parties',
  recordType: 'party',
  recordId: randomUUID(),
  fileName: 'contrato.pdf',
  contentType: 'application/pdf',
  size: 1024,
  sha256: 'a'.repeat(64),
  status: 'available',
  deletionReason: null,
  finding: null,
  uploadedBy: randomUUID(),
  createdAt: '2026-09-28T12:00:00.000Z',
  availableAt: '2026-09-28T12:00:01.000Z',
  expiresAt: null,
}

describe('attachment request', () => {
  it('accepts a record type its module takes', () => {
    expect(attachmentRequestSchema.safeParse(request).success).toBe(true)
    expect(
      attachmentRequestSchema.safeParse({ ...request, ownerPartyId: randomUUID() }).success,
    ).toBe(true)
  })

  it('refuses a record type of another module, and a module without attachments', () => {
    expect(
      attachmentRequestSchema.safeParse({ ...request, recordType: 'purchase-order' }).success,
    ).toBe(false)
    expect(attachmentRequestSchema.safeParse({ ...request, module: 'ledger' }).success).toBe(false)
  })

  it('refuses a type a browser would run, a path, and a file over the limit', () => {
    expect(
      attachmentRequestSchema.safeParse({ ...request, contentType: 'text/html' }).success,
    ).toBe(false)
    expect(
      attachmentRequestSchema.safeParse({ ...request, contentType: 'image/svg+xml' }).success,
    ).toBe(false)
    expect(
      attachmentRequestSchema.safeParse({ ...request, fileName: '../etc/passwd' }).success,
    ).toBe(false)
    expect(
      attachmentRequestSchema.safeParse({ ...request, size: ATTACHMENT_MAX_BYTES + 1 }).success,
    ).toBe(false)
  })
})

describe('attachment', () => {
  it('accepts an attachment in every state', () => {
    for (const status of ATTACHMENT_STATES)
      expect(attachmentSchema.safeParse({ ...attachment, status }).success).toBe(true)
  })

  it('refuses an unknown field', () => {
    expect(attachmentSchema.safeParse({ ...attachment, objectKey: 'x' }).success).toBe(false)
  })

  it('links only inside files', () => {
    const link = {
      method: 'GET',
      url: '/files/attachments/x/content',
      expiresAt: attachment.createdAt,
    }
    expect(attachmentLinkSchema.safeParse(link).success).toBe(true)
    expect(attachmentLinkSchema.safeParse({ ...link, url: 'https://evil.test/' }).success).toBe(
      false,
    )
  })
})

describe('attachment events', () => {
  const reference = {
    attachmentId: randomUUID(),
    module: 'crm',
    recordType: 'opportunity',
    recordId: randomUUID(),
  }

  it('never carries the file name', () => {
    expect(
      filesAttachmentAvailable.payload.safeParse({
        ...reference,
        contentType: 'image/png',
        size: 10,
      }).success,
    ).toBe(true)
    expect(
      filesAttachmentQuarantined.payload.safeParse({ ...reference, fileName: 'x.pdf' }).success,
    ).toBe(false)
  })

  it('says why an attachment ended', () => {
    expect(
      filesAttachmentDeleted.payload.safeParse({ ...reference, reason: 'erased' }).success,
    ).toBe(true)
    expect(filesAttachmentDeleted.payload.safeParse({ ...reference, reason: 'lost' }).success).toBe(
      false,
    )
  })
})
