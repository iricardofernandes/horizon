import { ATTACHABLE_RECORDS, type AttachingModule } from './vocabulary'

export type { AttachingModule }

/** A day, for retention arithmetic. */
export const DAY_MS = 86_400_000

/**
 * How long a file stays after it became available, per record type (Phase 65). A party's
 * files have no end: they go when the party is erased. Tax records are kept five years.
 */
const RETENTION_DAYS: Readonly<Record<AttachingModule, Readonly<Record<string, number | null>>>> = {
  parties: { party: null },
  procurement: { 'purchase-order': 1826 },
  financial: { receivable: 1826, payable: 1826 },
  sales: { 'service-order': 1826 },
  crm: { opportunity: 730 },
}

/** A quarantined file's row stays this long, with what the scanner found, then ends. */
export const QUARANTINE_KEPT_DAYS = 30

export type Action = 'read' | 'write'

/**
 * The owning modules' roles, as each module's own map grants the record's subject
 * (ADR 0023, ADR 0060). `files` has no roles: it reads these from the token.
 */
const ROLES: Readonly<Record<AttachingModule, Readonly<Record<Action, readonly string[]>>>> = {
  parties: { read: ['admin', 'editor', 'viewer'], write: ['admin', 'editor'] },
  procurement: { read: ['admin', 'buyer', 'approver', 'viewer'], write: ['admin', 'buyer'] },
  financial: { read: ['admin', 'operator', 'viewer'], write: ['admin', 'operator'] },
  sales: { read: ['admin', 'representative', 'viewer'], write: ['admin', 'representative'] },
  crm: {
    read: ['admin', 'manager', 'representative', 'viewer'],
    write: ['admin', 'manager', 'representative'],
  },
}

export interface RecordReference {
  readonly module: AttachingModule
  readonly recordType: string
  readonly recordId: string
}

export function isAttachable(module: string, recordType: string): module is AttachingModule {
  const types = ATTACHABLE_RECORDS[module as AttachingModule] as readonly string[] | undefined
  return types?.includes(recordType) ?? false
}

/** Days a file of this record type is kept once available; null when it has no end. */
export function retentionDaysOf(module: AttachingModule, recordType: string): number | null {
  const days = RETENTION_DAYS[module][recordType]
  if (days === undefined) throw new Error(`No retention declared for ${module}/${recordType}`)
  return days
}

export function expiryOf(record: RecordReference, availableAt: Date): Date | null {
  const days = retentionDaysOf(record.module, record.recordType)
  return days === null ? null : new Date(availableAt.getTime() + days * DAY_MS)
}

/** Whether any of the caller's roles in the owning module grants the action. */
export function permits(
  roles: readonly { readonly module: string; readonly role: string }[],
  module: AttachingModule,
  action: Action,
): boolean {
  const allowed = ROLES[module][action]
  return roles.some(
    (assignment) => assignment.module === module && allowed.includes(assignment.role),
  )
}

/** Every attachable record type, with its retention: what the screens and docs show. */
export function recordTypes() {
  return Object.entries(ATTACHABLE_RECORDS).flatMap(([module, types]) =>
    types.map((recordType) => ({
      module: module as AttachingModule,
      recordType,
      retentionDays: retentionDaysOf(module as AttachingModule, recordType),
    })),
  )
}
