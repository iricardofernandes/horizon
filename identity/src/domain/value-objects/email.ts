import { type Either, left, right } from '@/core/either'
import { ValueObject } from '@/core/entities/value-object'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'

interface EmailProps {
  readonly value: string
}

/**
 * An email address, normalised once at construction.
 *
 * Normalisation is not cosmetic here. The address is encrypted at rest and located by a
 * blind index — a keyed HMAC supporting exact match and nothing else (ADR 0026) — so
 * `Ana@Example.COM ` and `ana@example.com` must produce the same digest or the same
 * person gets two accounts and neither can log in reliably. Normalising in the
 * constructor is what makes that structural rather than a rule someone remembers.
 *
 * The local part is left alone: `a.b@gmail.com` and `ab@gmail.com` are the same mailbox
 * at one provider and different mailboxes at most others, and encoding one provider's
 * policy into a value object is how a system acquires a bug it cannot explain.
 */
export class Email extends ValueObject<EmailProps> {
  private static readonly PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/

  static create(raw: string, field = '/email'): Either<InvalidInputError, Email> {
    const normalised = raw.trim().toLowerCase()

    if (normalised.length === 0) return left(new InvalidInputError(field, 'email is required'))
    if (normalised.length > 254)
      return left(new InvalidInputError(field, 'email must be at most 254 characters'))
    if (!Email.PATTERN.test(normalised))
      return left(new InvalidInputError(field, 'email is not a valid address'))

    return right(new Email({ value: normalised }))
  }

  get value(): string {
    return this.props.value
  }

  /** The part a support engineer may see in a log line. Never the address itself. */
  get domain(): string {
    return this.props.value.slice(this.props.value.lastIndexOf('@') + 1)
  }

  protected componentsOf(): readonly unknown[] {
    return [this.props.value]
  }
}
