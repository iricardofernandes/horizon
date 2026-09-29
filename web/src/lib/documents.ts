/**
 * Document search (Phase 75): `knowledge` searches the attachments of every module the person
 * can read, and answers citations. The web only decides whether to ask, and how to show them.
 */
import { type AttachingModule, type AttachmentRecord, attachmentAbilities } from './attachments'

export type DocumentCitation = {
  attachmentId: string
  record: { module: AttachingModule; recordType: string; recordId: string }
  /** The path of the record's screen. */
  screen: string
  position: { chunk: number; of: number }
  excerpt: string
  score: number
  matchedBy: ('meaning' | 'words')[]
}

export type DocumentAnswer = { data: DocumentCitation[]; searched: AttachingModule[] }

const MODULES: readonly AttachingModule[] = ['parties', 'procurement', 'financial', 'sales', 'crm']

/** Whether the person reads any module whose attachments are searched. */
export function canSearchDocuments(roles: readonly { module: string; role: string }[]): boolean {
  return MODULES.some((module) => attachmentAbilities(roles, module).canRead)
}

export const DOCUMENT_SEARCH_MIN = 2
export const DOCUMENT_SEARCH_MAX = 200

/** The proxied search, for the whole workspace or one record's attachments. */
export function documentSearchPath(
  text: string,
  options: { limit?: number; record?: AttachmentRecord } = {},
): string {
  const query = new URLSearchParams({ q: text.trim().slice(0, DOCUMENT_SEARCH_MAX) })
  if (options.limit) query.set('limit', String(options.limit))
  if (options.record) {
    query.set('module', options.record.module)
    query.set('recordType', options.record.recordType)
    query.set('recordId', options.record.recordId)
  }
  return `/api/horizon/knowledge/search?${query.toString()}`
}

/** An excerpt on one line, cut on a word near `max` characters. */
export function excerptLine(text: string, max = 110): string {
  const line = text.replace(/\s+/g, ' ').trim()
  if (line.length <= max) return line
  const cut = line.lastIndexOf(' ', max)
  return `${line.slice(0, cut > max / 2 ? cut : max)}…`
}
