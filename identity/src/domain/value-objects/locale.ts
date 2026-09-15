import { type Either, left, right } from '@/core/either'
import { ValueObject } from '@/core/entities/value-object'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'

interface LocaleProps {
  readonly value: string
}

/**
 * A reader's display language, as a BCP 47 tag.
 *
 * It belongs to the global account rather than to a workspace membership: the same person
 * reading two workspaces reads both in the language they chose (ADR 0044). The interface
 * decides which tags it can render; this validates the tag itself, canonicalised by the
 * runtime rather than checked against a list that would be wrong within a year.
 */
export class Locale extends ValueObject<LocaleProps> {
  static create(raw: string, field = '/preferredLocale'): Either<InvalidInputError, Locale> {
    const candidate = raw.trim()
    if (candidate.length === 0) return left(new InvalidInputError(field, 'locale is required'))
    if (candidate.length > 35)
      return left(new InvalidInputError(field, 'locale is longer than a BCP 47 tag'))

    const canonical = Locale.canonicalise(candidate)
    if (canonical === null)
      return left(new InvalidInputError(field, `"${candidate}" is not a valid BCP 47 language tag`))

    return right(new Locale({ value: canonical }))
  }

  private static canonicalise(candidate: string): string | null {
    try {
      const locale = new Intl.Locale(candidate)
      return locale.language.length > 0 ? locale.toString() : null
    } catch {
      return null
    }
  }

  get value(): string {
    return this.props.value
  }

  protected componentsOf(): readonly unknown[] {
    return [this.props.value]
  }
}
