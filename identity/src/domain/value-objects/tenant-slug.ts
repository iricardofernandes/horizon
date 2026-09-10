import { type Either, left, right } from '@/core/either'
import { ValueObject } from '@/core/entities/value-object'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'

interface TenantSlugProps {
  readonly value: string
}

/**
 * The handle a user types at login, before any tenant context exists.
 *
 * It is deliberately not personal data and deliberately not secret: it is the one value
 * that must be resolvable *before* `app.current_tenant` is set, which is why it lives in
 * its own unscoped directory table rather than on the RLS-protected `tenants` row
 * (ADR 0037).
 */
export class TenantSlug extends ValueObject<TenantSlugProps> {
  private static readonly PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

  static create(raw: string, field = '/slug'): Either<InvalidInputError, TenantSlug> {
    const normalised = raw.trim().toLowerCase()

    if (normalised.length < 3)
      return left(new InvalidInputError(field, 'slug must be at least 3 characters'))
    if (normalised.length > 63)
      return left(new InvalidInputError(field, 'slug must be at most 63 characters'))
    if (!TenantSlug.PATTERN.test(normalised))
      return left(
        new InvalidInputError(field, 'slug must be lowercase alphanumeric words joined by hyphens'),
      )

    return right(new TenantSlug({ value: normalised }))
  }

  get value(): string {
    return this.props.value
  }

  protected componentsOf(): readonly unknown[] {
    return [this.props.value]
  }
}
