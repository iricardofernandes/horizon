import { type Either, left, right } from '@/core/either'
import { ValueObject } from '@/core/entities/value-object'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'

interface PasswordHashProps {
  readonly encoded: string
  readonly memoryKib: number
  readonly timeCost: number
  readonly parallelism: number
}

/** The Argon2id cost policy currently in force, read from configuration (ADR 0019). */
export interface Argon2Policy {
  readonly memoryKib: number
  readonly timeCost: number
  readonly parallelism: number
}

/**
 * An Argon2id hash, and the parameters it was produced with.
 *
 * The parameters are *parsed out of the encoded string* rather than stored alongside it,
 * because the encoded string is the only thing that survives a restore from backup — and
 * because that is what makes rehash-on-login possible: a hash produced under a weaker
 * policy announces itself, so the corpus upgrades as people log in without a migration
 * and without anyone noticing (ADR 0019).
 *
 * Parsing lives here rather than in the hasher adapter so `needsRehash` is unit-testable
 * against a literal string, with no 19 MiB allocation per assertion.
 */
export class PasswordHash extends ValueObject<PasswordHashProps> {
  private static readonly ENCODED =
    /^\$argon2id\$v=(?<version>\d+)\$m=(?<m>\d+),t=(?<t>\d+),p=(?<p>\d+)\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/

  static create(encoded: string): Either<InvalidInputError, PasswordHash> {
    const match = PasswordHash.ENCODED.exec(encoded)
    if (match?.groups === undefined)
      return left(
        new InvalidInputError('/passwordHash', 'not a recognisable Argon2id encoded hash'),
      )

    const { m, t, p } = match.groups
    if (m === undefined || t === undefined || p === undefined)
      return left(new InvalidInputError('/passwordHash', 'Argon2id hash is missing its parameters'))

    return right(
      new PasswordHash({
        encoded,
        memoryKib: Number(m),
        timeCost: Number(t),
        parallelism: Number(p),
      }),
    )
  }

  get encoded(): string {
    return this.props.encoded
  }

  /**
   * Below policy on any axis. Deliberately not an equality check: a hash produced under a
   * *stronger* policy than the current one is not upgraded, because downgrading a
   * credential on login would be the opposite of the point.
   */
  needsRehash(policy: Argon2Policy): boolean {
    return (
      this.props.memoryKib < policy.memoryKib ||
      this.props.timeCost < policy.timeCost ||
      this.props.parallelism < policy.parallelism
    )
  }

  protected componentsOf(): readonly unknown[] {
    return [this.props.encoded]
  }
}
