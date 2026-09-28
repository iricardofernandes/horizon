/**
 * The web side of the bulk import contract (ADR 0059): which modules import, how a file
 * becomes an upload body, and how a job's progress reads. Nothing here decides whether a
 * row is valid — the owning module does.
 */

export const IMPORTING_MODULES = ['parties', 'catalog', 'inventory', 'financial'] as const
export type ImportingModule = (typeof IMPORTING_MODULES)[number]

export type ImportState =
  | 'uploaded'
  | 'validated'
  | 'previewed'
  | 'running'
  | 'completed'
  | 'completed-with-failures'
  | 'cancelled'

export type ImportProgress = {
  total: number
  valid: number
  written: number
  failed: number
  remaining: number
  cancelled: number
}

export type ImportJob = {
  id: string
  kind: string
  status: ImportState
  fileName: string
  format: 'csv' | 'xlsx'
  columns: string[]
  mapping: Record<string, string | null> | null
  progress: ImportProgress
  createdAt: string
  finishedAt: string | null
  failuresUntil: string | null
}

export type ImportField = { name: string; required: boolean; description: string }
export type ImportKind = { kind: string; fields: ImportField[] }
export type ImportPreview = {
  job: ImportJob
  errors: { line: number; reasons: { field: string | null; message: string }[] }[]
  sample: { line: number; values: Record<string, string | null> }[]
}

/** The largest file a module accepts, before base64 (`IMPORT_MAX_BYTES`). */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024

/** Importing is an administrator's work in every module that imports (Phase 64). */
export function importingModules(
  roles: readonly { module: string; role: string }[],
): ImportingModule[] {
  return IMPORTING_MODULES.filter((module) =>
    roles.some((assignment) => assignment.module === module && assignment.role === 'admin'),
  )
}

export function formatOf(fileName: string): 'csv' | 'xlsx' | null {
  const extension = fileName.toLowerCase().split('.').at(-1)
  if (extension === 'csv' || extension === 'txt') return 'csv'
  if (extension === 'xlsx') return 'xlsx'
  return null
}

/** A CSV's text: UTF-8 when it is, else the Windows-1252 a spreadsheet often saves. */
export function csvText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('windows-1252').decode(bytes)
  }
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let start = 0; start < bytes.length; start += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000))
  return btoa(binary)
}

export function uploadBody(
  fileName: string,
  bytes: Uint8Array,
  locale: 'pt-BR' | 'en',
): { fileName: string; format: 'csv' | 'xlsx'; locale: 'pt-BR' | 'en'; content: string } | null {
  const format = formatOf(fileName)
  if (!format || bytes.byteLength === 0 || bytes.byteLength > MAX_IMPORT_BYTES) return null
  return {
    fileName,
    format,
    locale,
    content: format === 'csv' ? csvText(bytes) : base64(bytes),
  }
}

/**
 * The job key: the same file for the same kind is the same job, so sending it twice finds
 * the import already made instead of making another.
 */
export async function jobKeyOf(kind: string, bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new Uint8Array([...new TextEncoder().encode(`${kind}\u0000`), ...bytes]),
  )
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function isFinished(status: ImportState): boolean {
  return status === 'completed' || status === 'completed-with-failures' || status === 'cancelled'
}

/** How much of the file is accounted for, as a whole percentage. */
export function percentDone(progress: ImportProgress): number {
  if (progress.total === 0) return 100
  const done = progress.written + progress.failed + progress.cancelled
  return Math.floor((done * 100) / progress.total)
}

/** The screen never shows counts that leave a row unaccounted for. */
export function addsUp(progress: ImportProgress): boolean {
  return (
    progress.total === progress.written + progress.failed + progress.remaining + progress.cancelled
  )
}
