import { type Either, left, right } from '@/core/either'
import { ValueObject } from '@/core/entities/value-object'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'

interface TenantNameProps {
  readonly value: string
}

/** A tenant's display name. Not unique, and not an identifier. */
export class TenantName extends ValueObject<TenantNameProps> {
  static create(raw: string, field = '/name'): Either<InvalidInputError, TenantName> {
    const collapsed = raw.trim().replace(/\s+/g, ' ')

    if (collapsed.length === 0) return left(new InvalidInputError(field, 'name is required'))
    if (collapsed.length > 200)
      return left(new InvalidInputError(field, 'name must be at most 200 characters'))

    return right(new TenantName({ value: collapsed }))
  }

  get value(): string {
    return this.props.value
  }

  protected componentsOf(): readonly unknown[] {
    return [this.props.value]
  }
}
