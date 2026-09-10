import { type Either, left, right } from '@/core/either'
import { ValueObject } from '@/core/entities/value-object'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'

interface ApiKeyTokenProps {
  readonly environment: string
  readonly prefix: string
  readonly secret: string
}

/**
 * `hz_<env>_<24-char prefix>_<32-char secret>` (ADR 0022).
 *
 * Every segment earns its place. `hz_` makes the string recognisable to a secret scanner
 * and to a human reading a paste. `<env>` stops the classic incident where a test key
 * reaches production. The **prefix is stored in plaintext and indexed**, so a key found
 * in a log can be identified and revoked without its holder producing it, and so lookup
 * is one indexed equality before any Argon2id work happens. The **secret is Argon2id-
 * hashed** and never stored, logged or displayed after creation.
 *
 * Parsing is total and never throws: an unparseable presented credential is an
 * authentication failure, not a fault.
 */
export class ApiKeyToken extends ValueObject<ApiKeyTokenProps> {
  static readonly PREFIX_LENGTH = 24
  static readonly SECRET_LENGTH = 32

  private static readonly PATTERN =
    /^hz_(?<env>live|test|dev)_(?<prefix>[A-Za-z0-9]{24})_(?<secret>[A-Za-z0-9]{32})$/

  static create(props: ApiKeyTokenProps): ApiKeyToken {
    return new ApiKeyToken(props)
  }

  static parse(raw: string): Either<InvalidInputError, ApiKeyToken> {
    const match = ApiKeyToken.PATTERN.exec(raw.trim())
    const groups = match?.groups
    if (groups === undefined)
      return left(new InvalidInputError('/apiKey', 'not a well-formed Horizon API key'))

    const { env, prefix, secret } = groups
    if (env === undefined || prefix === undefined || secret === undefined)
      return left(new InvalidInputError('/apiKey', 'not a well-formed Horizon API key'))

    return right(new ApiKeyToken({ environment: env, prefix, secret }))
  }

  get environment(): string {
    return this.props.environment
  }

  /** Safe to log, safe to index, useless on its own. */
  get prefix(): string {
    return this.props.prefix
  }

  /** Never persisted and never logged. Hashed at creation, compared at authentication. */
  get secret(): string {
    return this.props.secret
  }

  /** The full credential. Returned to the caller exactly once, at creation. */
  override toString(): string {
    return `hz_${this.props.environment}_${this.props.prefix}_${this.props.secret}`
  }

  protected componentsOf(): readonly unknown[] {
    return [this.props.environment, this.props.prefix, this.props.secret]
  }
}
