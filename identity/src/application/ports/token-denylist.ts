/**
 * `unavailable` is a first-class answer, not an exception (ADR 0021).
 *
 * Making the store's absence a value the caller must handle is what forces the
 * asymmetric decision to be taken explicitly at each call site instead of being a
 * `catch` block somebody wrote once: **closed for privileged operations, open for
 * read-only ones**. A boolean return would have hidden the third state, and the third
 * state is the entire decision.
 */
export type DenylistVerdict = 'allowed' | 'denied' | 'unavailable'

export abstract class TokenDenylist {
  /** TTL equal to the token's remaining lifetime, so the list never grows unbounded. */
  abstract revoke(jti: string, expiresAt: Date): Promise<void>

  abstract check(jti: string): Promise<DenylistVerdict>

  /**
   * Deny **every** token for a subject until `until`.
   *
   * A `jti` denylist alone cannot express "disable this user", because identity does not
   * retain the identifiers of the tokens it has issued — and retaining them would
   * reintroduce, at greater cost, exactly the server-side session state that stateless
   * access tokens exist to avoid.
   *
   * So the denylist has a second key space, keyed by subject, written when a user is
   * disabled or erased. It is bounded by the same 15 minutes as the first: after the
   * longest-lived outstanding token has expired, the entry is meaningless and Redis drops
   * it. Same store, same failure semantics, same asymmetric behaviour on unavailability
   * (ADR 0021).
   */
  abstract revokeSubject(subject: string, until: Date): Promise<void>

  abstract checkSubject(subject: string): Promise<DenylistVerdict>
}
