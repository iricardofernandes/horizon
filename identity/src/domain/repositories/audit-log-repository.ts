import type { Actor, AuditEntry } from '@/domain/audit/audit-entry'

/**
 * Everything an entry needs that the caller knows and the repository does not.
 *
 * `before` and `after` are **plaintext here and ciphertext by the time they are hashed**.
 * That ordering is what makes ADR 0025 and ADR 0026 compatible instead of contradictory:
 * the chain is computed over the encrypted diff, so destroying a subject's key changes
 * nothing the chain hashed, and the log still verifies after a lawful erasure. Hashing
 * the plaintext would make every erasure indistinguishable from tampering.
 */
export interface AuditRecord {
  readonly actor: Actor
  readonly subjectType: string
  readonly subjectId: string
  readonly action: string
  readonly before?: Record<string, unknown> | null
  readonly after?: Record<string, unknown> | null
  /**
   * Whose key the diff is encrypted under, when the entry concerns a data subject.
   * `null` for entries about a tenant or a configuration change, which hold no personal
   * data and are stored in the clear so they remain readable forever.
   */
  readonly dataSubjectId?: string | null
  readonly requestId?: string | null
  readonly traceId?: string | null
  readonly sourceIp?: string | null
  readonly occurredAt: Date
}

export abstract class AuditLogRepository {
  /**
   * Append one entry, redacting and chaining it.
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
