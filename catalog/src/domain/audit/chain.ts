import { createHash } from 'node:crypto'

import { canonicalJson } from './canonical-json'

/** The chain's zero value — what `previous_hash` holds for a tenant's first entry. */
export const GENESIS_HASH = '0'.repeat(64)

/** What gets hashed. Every field an auditor would need to detect a change to. */
export interface HashedAuditPayload {
  readonly sequence: number
  readonly tenantId: string
  readonly actorType: string
  readonly actorId: string | null
  readonly subjectType: string
  readonly subjectId: string
  readonly action: string
  readonly occurredAt: Date
  readonly requestId: string | null
  readonly traceId: string | null
  readonly sourceIp: string | null
  readonly before: Record<string, unknown> | null
  readonly after: Record<string, unknown> | null
  /**
   * **Inside the hash, and that is the point** (ADR 0025).
   *
   * If the redaction list lived outside the hashed payload, an attacker could hide a
   * change by retroactively declaring the changed field sensitive — the field would
   * disappear from `before`/`after`, and the chain would still verify. Inside it,
   * altering *what was redacted* breaks the chain exactly as altering the data does.
   */
  readonly redacted: readonly string[]
}

/**
 * `hash = sha256(previous_hash || canonical_json(payload))`.
 *
 * The concatenation is of the previous hash's hex text and the canonical JSON text, in
 * that order, encoded UTF-8. Stated explicitly because "concatenate" has several
 * plausible readings and a verifier written from the prose must agree with this one.
 */
export function chainHash(previousHash: string, payload: HashedAuditPayload): string {
  return createHash('sha256')
    .update(previousHash, 'utf8')
    .update(canonicalJson({ ...payload, redacted: [...payload.redacted].sort() }), 'utf8')
    .digest('hex')
}
