import { type Either, left, right } from '@/core/either'
import { ValueObject } from '@/core/entities/value-object'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { type Money, type Share, WHOLE } from './financial-values'

export const MAX_ALLOCATION_ENTRIES = 50

export interface AllocationEntry {
  readonly dimensionId: string
  readonly share: Share
}

/**
 * How one amount is divided across departments or projects.
 *
 * Exactly 100%, each dimension once. An allocation of 60% to Sales and 30% to Marketing
 * leaves a tenth of the money belonging to no one, and every departmental report built
 * on it quietly under-reports the total.
 */
export class Allocation extends ValueObject<{ readonly entries: readonly AllocationEntry[] }> {
  static of(entries: readonly AllocationEntry[]): Either<InvalidInputError, Allocation> {
    if (entries.length < 1 || entries.length > MAX_ALLOCATION_ENTRIES)
      return left(
        new InvalidInputError(
          '/entries',
          `must allocate to between 1 and ${MAX_ALLOCATION_ENTRIES} dimensions`,
        ),
      )
    const ids = new Set(entries.map((entry) => entry.dimensionId))
    if (ids.size !== entries.length)
      return left(new InvalidInputError('/entries', 'each dimension may appear only once'))
    const total = entries.reduce((sum, entry) => sum + entry.share.basisPoints, 0)
    if (total !== WHOLE)
      return left(
        new InvalidInputError('/entries', 'allocation percentages must add up to exactly 100%'),
      )
    return right(new Allocation({ entries: [...entries] }))
  }

  get entries(): readonly AllocationEntry[] {
    return this.props.entries
  }

  /** The amount each dimension receives; the parts always add up to the whole amount. */
  split(
    total: Money,
  ): readonly { readonly dimensionId: string; readonly share: Share; readonly amount: Money }[] {
    const amounts = total.allocate(this.props.entries.map((entry) => entry.share))
    return this.props.entries.map((entry, index) => ({ ...entry, amount: amounts[index] ?? total }))
  }

  protected componentsOf(): readonly unknown[] {
    return this.props.entries.map((entry) => `${entry.dimensionId}:${entry.share.basisPoints}`)
  }
}
