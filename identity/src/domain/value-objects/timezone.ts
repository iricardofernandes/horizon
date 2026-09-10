import { type Either, left, right } from '@/core/either'
import { ValueObject } from '@/core/entities/value-object'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'

interface TimezoneProps {
  readonly value: string
}

/**
 * An IANA zone, applied at presentation only — storage and comparison are always UTC
 * (ADR 0011).
 *
 * Validated against the runtime's own zone database rather than a hand-kept list, because
 * zone names change (`Europe/Kiev` became `Europe/Kyiv`) and a list in this file would be
 * wrong within a year.
 */
export class Timezone extends ValueObject<TimezoneProps> {
  static create(raw: string, field = '/timezone'): Either<InvalidInputError, Timezone> {
    const candidate = raw.trim()

    if (candidate.length === 0) return left(new InvalidInputError(field, 'timezone is required'))
    if (!Timezone.isKnownZone(candidate))
      return left(new InvalidInputError(field, `"${candidate}" is not a known IANA timezone`))

    return right(new Timezone({ value: candidate }))
  }

  private static isKnownZone(candidate: string): boolean {
    try {
      // Resolving the zone is the validation: an unknown identifier raises RangeError
      // here, and a known one comes back canonicalised.
      return (
        new Intl.DateTimeFormat('en-US', { timeZone: candidate }).resolvedOptions().timeZone
          .length > 0
      )
    } catch {
      return false
    }
  }

  get value(): string {
    return this.props.value
  }

  protected componentsOf(): readonly unknown[] {
    return [this.props.value]
  }
}
