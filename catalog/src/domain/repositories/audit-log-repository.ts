import type { Actor, AuditEntry } from '@/domain/audit/audit-entry'

/**
 * Everything an entry needs that the caller knows and the repository does not.
 *
 * There is no `dataSubjectId` here, and its absence is a statement rather than an
 * omission: a catalogue holds products, units and prices, not people. Identity encrypts
 * its audit diffs under a subject key so that crypto-shredding (ADR 0026) leaves the
 * chain verifiable; Catalog has no subject to shred, so its diffs are stored in the
 * clear and stay readable forever. A module that later records personal data here owes
 * the encryption step before the first such entry is written, not after.
 */
export interface AuditRecord {
  readonly actor: Actor
  readonly subjectType: string
  readonly subjectId: string
  readonly action: string
  readonly before?: Record<string, unknown> | null
  readonly after?: Record<string, unknown> | null
  readonly requestId?: string | null
  readonly traceId?: string | null
  readonly sourceIp?: string | null
  readonly occurredAt: Date
}

export abstract class AuditLogRepository {
  /**
   * Append one entry, chaining it.
   *
   * The sequence number and the previous hash are the repository's business, not the
   * caller's: they must be read and written inside the same transaction as the entry, or
   * two concurrent writers produce two rows claiming the same predecessor.
   */
  abstract append(record: AuditRecord): Promise<AuditEntry>

  /** In sequence order, for the verifier. Bounded: a chain can be long. */
  abstract walk(fromSequence: number, limit: number): Promise<readonly AuditEntry[]>

  abstract lastSequence(): Promise<number>
}
