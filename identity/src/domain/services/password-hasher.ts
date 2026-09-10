/**
 * Hashing and verification, as the domain sees it.
 *
 * A *domain service* rather than an application port, and deliberately so: it is
 * `User.verifyPassword()` that needs it, not a use case. Without it the aggregate would
 * have to expose its hash so something outside could compare it — which is the accessor
 * ADR 0031 rule 5 forbids, on the one field where exposure matters most.
 *
 * The interface names no algorithm. `Argon2PasswordHasher` in `infrastructure/` supplies
 * the parameters; the unit suite supplies a fake that does not allocate 19 MiB per
 * assertion (ADR 0019).
 */
export abstract class PasswordHasher {
  abstract hash(plaintext: string): Promise<string>

  /**
   * Constant-time inside the implementation, and total: a malformed stored hash is
   * `false`, never a throw. An exception here would turn a corrupt row into a 500 that
   * distinguishes it from a wrong password, which is an oracle.
   */
  abstract verify(encoded: string, plaintext: string): Promise<boolean>

  /**
   * Burn roughly the cost of a real verification against a value that cannot match.
   *
   * Called when no user was found, so that "no such account" and "wrong password" take
   * the same time. Skipping it makes response latency an account-existence oracle, which
   * is the whole reason this is on the interface rather than left to each caller.
   */
  abstract verifyDummy(): Promise<void>
}
