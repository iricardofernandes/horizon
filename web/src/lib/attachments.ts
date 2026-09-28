/**
 * The web side of attachments (ADR 0060): which records take them, which roles read and
 * attach, and what a chosen file is declared as. `files` checks all of it again; this only
 * spares the person a round trip.
 */

export type AttachingModule = 'parties' | 'procurement' | 'financial' | 'sales' | 'crm'

export type AttachmentRecord = {
  module: AttachingModule
  recordType: string
  recordId: string
  /** The party the record is about, whose erasure shreds its files. */
  ownerPartyId?: string
}

export type AttachmentState = 'uploading' | 'scanning' | 'available' | 'quarantined' | 'deleted'

export type Attachment = {
  id: string
  fileName: string
  contentType: string
  size: number
  status: AttachmentState
  finding: string | null
  uploadedBy: string
  createdAt: string
  expiresAt: string | null
}

export type AttachmentLink = { method: 'PUT' | 'GET'; url: string; expiresAt: string }

/** 10 MiB, as `files` declares it. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024

const TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  txt: 'text/plain',
  csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

/** What `accept` offers in the file picker. */
export const ACCEPTED_EXTENSIONS = Object.keys(TYPES)
  .map((extension) => `.${extension}`)
  .join(',')

/**
 * The accepted type of a file, from its extension: browsers label a CSV as anything from
 * `text/csv` to `application/vnd.ms-excel`, and `files` checks the bytes anyway.
 */
export function contentTypeOf(fileName: string): string | null {
  const extension = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase()
  return extension ? (TYPES[extension] ?? null) : null
}

export type FileRefusal = 'type' | 'size' | 'empty'

export function refusalOf(file: { name: string; size: number }): FileRefusal | null {
  if (!contentTypeOf(file.name)) return 'type'
  if (file.size === 0) return 'empty'
  if (file.size > ATTACHMENT_MAX_BYTES) return 'size'
  return null
}

/** The slot request `files` expects for this file on this record. */
export function slotRequestOf(record: AttachmentRecord, file: { name: string; size: number }) {
  return {
    module: record.module,
    recordType: record.recordType,
    recordId: record.recordId,
    fileName: file.name.replace(/[\\/]/g, '_').slice(0, 255),
    contentType: contentTypeOf(file.name),
    size: file.size,
    ...(record.ownerPartyId && record.module !== 'parties'
      ? { ownerPartyId: record.ownerPartyId }
      : {}),
  }
}

/** The owning modules' roles that read and attach, as `files` maps them. */
const ROLES: Readonly<Record<AttachingModule, { read: string[]; write: string[] }>> = {
  parties: { read: ['admin', 'editor', 'viewer'], write: ['admin', 'editor'] },
  procurement: { read: ['admin', 'buyer', 'approver', 'viewer'], write: ['admin', 'buyer'] },
  financial: { read: ['admin', 'operator', 'viewer'], write: ['admin', 'operator'] },
  sales: { read: ['admin', 'representative', 'viewer'], write: ['admin', 'representative'] },
  crm: {
    read: ['admin', 'manager', 'representative', 'viewer'],
    write: ['admin', 'manager', 'representative'],
  },
}

export function attachmentAbilities(
  roles: readonly { module: string; role: string }[],
  module: AttachingModule,
) {
  const held = roles.filter((assignment) => assignment.module === module)
  return {
    canRead: held.some((assignment) => ROLES[module].read.includes(assignment.role)),
    canWrite: held.some((assignment) => ROLES[module].write.includes(assignment.role)),
  }
}

/** Whether the list must be asked again soon: a scan has not answered yet. */
export function isSettling(attachments: readonly Attachment[]): boolean {
  return attachments.some((attachment) => attachment.status === 'scanning')
}

/** The proxy path of a signed `files` link. */
export function proxied(link: AttachmentLink): string {
  if (!link.url.startsWith('/files/')) throw new Error('Not a files link')
  return `/api/horizon${link.url}`
}

/** A size a person reads: bytes, then KB, then MB with one decimal. */
export function sizeLabel(bytes: number, number: (value: number, digits: number) => string) {
  if (bytes < 1024) return `${number(bytes, 0)} B`
  if (bytes < 1024 * 1024) return `${number(bytes / 1024, 0)} KB`
  return `${number(bytes / (1024 * 1024), 1)} MB`
}
