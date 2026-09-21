import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { CatalogCompositionDefinedEvent } from '../events/catalog-events'
import type { ComponentQuantity, EffectiveDate } from '../value-objects/catalog-values'

/**
 * Whether the parent is a thing in its own right, or a name for its parts.
 *
 * `assembled` is a recipe: the parent is stocked, and something has to make it out of the
 * components. `exploded` is a bundle: the parent is never stocked at all, and wherever it
 * is used it stands for what is underneath it. The two look alike on paper and behave
 * nothing alike in a warehouse, which is why the composition has to say which it is
 * rather than leaving a reader to guess from whether any stock ever turned up.
 */
export const REALISATIONS = ['assembled', 'exploded'] as const
export type Realisation = (typeof REALISATIONS)[number]

/** How much of one component goes into one of the parent. */
export interface ComponentLine {
  readonly componentItemId: string
  readonly quantity: ComponentQuantity
}

const MOST_COMPONENTS = 200

interface CompositionProps {
  tenantId: string
  parentItemId: string
  version: number
  realisation: Realisation
  effectiveFrom: EffectiveDate
  lines: readonly ComponentLine[]
  definedBy: string
  definedAt: Date
}

/**
 * What an item is made of, from a date.
 *
 * Versioned rather than edited, because a recipe changes and the goods made under the old
 * one have to stay explicable: a production order that consumed four of something is not
 * wrong because the recipe now says three. Superseding is adding a version that takes
 * effect later, and nothing ever rewrites one that has been published.
 *
 * What this aggregate cannot see is the rest of the graph — whether a component is itself
 * made of the parent, somewhere far below. That is a fact about every composition at
 * once, so it is checked against the repository before this is built and again by the
 * database.
 */
export class Composition extends AggregateRoot<CompositionProps> {
  static rehydrate(props: CompositionProps, id: UniqueEntityID): Composition {
    return new Composition(props, id)
  }

  static define(
    props: {
      tenantId: string
      parentItemId: string
      version: number
      realisation: Realisation
      effectiveFrom: EffectiveDate
      lines: readonly ComponentLine[]
      definedBy: string
      now: Date
    },
    id?: UniqueEntityID,
  ): Either<ConflictError, Composition> {
    if (props.lines.length === 0)
      return left(new ConflictError('a composition needs at least one component'))
    if (props.lines.length > MOST_COMPONENTS)
      return left(new ConflictError(`a composition holds at most ${MOST_COMPONENTS} components`))
    const seen = new Set<string>()
    for (const line of props.lines) {
      if (line.componentItemId === props.parentItemId)
        return left(new ConflictError('an item is not made of itself'))
      if (seen.has(line.componentItemId))
        return left(
          new ConflictError('a component appears at most once; state the quantity instead'),
        )
      seen.add(line.componentItemId)
    }
    const composition = new Composition(
      {
        tenantId: props.tenantId,
        parentItemId: props.parentItemId,
        version: props.version,
        realisation: props.realisation,
        effectiveFrom: props.effectiveFrom,
        lines: props.lines,
        definedBy: props.definedBy,
        definedAt: props.now,
      },
      id,
    )
    composition.addDomainEvent(
      new CatalogCompositionDefinedEvent(composition.id, props.tenantId, props.now, {
        parentItemId: props.parentItemId,
        version: props.version,
        realisation: props.realisation,
        effectiveFrom: props.effectiveFrom.value,
        lines: props.lines.map((line) => ({
          componentItemId: line.componentItemId,
          quantity: line.quantity.toString(),
        })),
      }),
    )
    return right(composition)
  }

  belongsTo(tenantId: string): boolean {
    return this.props.tenantId === tenantId
  }

  parentItemId(): string {
    return this.props.parentItemId
  }

  version(): number {
    return this.props.version
  }

  realisation(): Realisation {
    return this.props.realisation
  }

  effectiveFrom(): EffectiveDate {
    return this.props.effectiveFrom
  }

  lines(): readonly ComponentLine[] {
    return this.props.lines
  }

  toSnapshot(): Readonly<{
    id: string
    tenantId: string
    parentItemId: string
    version: number
    realisation: Realisation
    effectiveFrom: string
    lines: readonly { componentItemId: string; quantity: string }[]
    definedBy: string
    definedAt: Date
  }> {
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      parentItemId: this.props.parentItemId,
      version: this.props.version,
      realisation: this.props.realisation,
      effectiveFrom: this.props.effectiveFrom.value,
      lines: this.props.lines.map((line) => ({
        componentItemId: line.componentItemId,
        quantity: line.quantity.toString(),
      })),
      definedBy: this.props.definedBy,
      definedAt: this.props.definedAt,
    })
  }
}
