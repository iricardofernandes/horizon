import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { CatalogFamilyDefinedEvent } from '../events/catalog-events'
import type { AttributeName, AttributeValue, CatalogName } from '../value-objects/catalog-values'

/** How many axes one family may have before it stops being one product. */
const MOST_ATTRIBUTES = 8

interface FamilyProps {
  tenantId: string
  name: CatalogName
  attributes: readonly AttributeName[]
  active: boolean
  createdAt: Date
  updatedAt: Date
}

/** One variant's answer for one axis, as the caller gave it. */
export interface AttributeAnswer {
  readonly attribute: AttributeName
  readonly value: AttributeValue
}

/**
 * A group of items that differ only along named axes.
 *
 * The family is not a thing anybody stocks or sells. It is how a catalogue says that
 * these forty shirts are one shirt in forty combinations, so a person choosing can be
 * offered the choice rather than made to scroll past forty unrelated products.
 *
 * Its attributes are ordered and fixed once anything is in it: a family that gained a
 * third axis would leave every variant already in it unable to answer, and one that lost
 * an axis would make two variants that used to differ identical.
 */
export class ProductFamily extends AggregateRoot<FamilyProps> {
  static rehydrate(props: FamilyProps, id: UniqueEntityID): ProductFamily {
    return new ProductFamily(props, id)
  }

  static define(
    props: {
      tenantId: string
      name: CatalogName
      attributes: readonly AttributeName[]
      now: Date
    },
    id?: UniqueEntityID,
  ): Either<ConflictError, ProductFamily> {
    if (props.attributes.length === 0)
      return left(new ConflictError('a family needs at least one attribute to vary along'))
    if (props.attributes.length > MOST_ATTRIBUTES)
      return left(new ConflictError(`a family varies along at most ${MOST_ATTRIBUTES} attributes`))
    const keys = new Set(props.attributes.map((attribute) => attribute.key))
    if (keys.size !== props.attributes.length)
      return left(new ConflictError('an attribute appears at most once in a family'))
    const family = new ProductFamily(
      {
        tenantId: props.tenantId,
        name: props.name,
        attributes: props.attributes,
        active: true,
        createdAt: props.now,
        updatedAt: props.now,
      },
      id,
    )
    family.addDomainEvent(
      new CatalogFamilyDefinedEvent(family.id, props.tenantId, props.now, {
        name: props.name.value,
        attributes: props.attributes.map((attribute) => attribute.value),
      }),
    )
    return right(family)
  }

  /**
   * The answers a variant gives, checked against the axes this family varies along.
   *
   * Every axis, exactly once, and nothing else: a variant that left one unanswered could
   * not be told from its siblings, and one that answered an axis the family does not have
   * would be describing a different product.
   */
  accept(answers: readonly AttributeAnswer[]): Either<ConflictError, readonly AttributeAnswer[]> {
    if (!this.props.active) return left(new ConflictError('this family is no longer in use'))
    const given = new Map<string, AttributeAnswer>()
    for (const answer of answers) {
      if (given.has(answer.attribute.key))
        return left(new ConflictError(`attribute "${answer.attribute.value}" was answered twice`))
      given.set(answer.attribute.key, answer)
    }
    const ordered: AttributeAnswer[] = []
    for (const attribute of this.props.attributes) {
      const answer = given.get(attribute.key)
      if (!answer) return left(new ConflictError(`attribute "${attribute.value}" was not answered`))
      given.delete(attribute.key)
      // Kept under the family's own spelling, so two variants that answered "Colour" and
      // "colour" read the same way down the list.
      ordered.push({ attribute, value: answer.value })
    }
    const [extra] = [...given.values()]
    if (extra)
      return left(new ConflictError(`this family does not vary along "${extra.attribute.value}"`))
    return right(ordered)
  }

  deactivate(now: Date): Either<ConflictError, void> {
    if (!this.props.active) return left(new ConflictError('this family is already out of use'))
    this.props.active = false
    this.props.updatedAt = now
    return right(undefined)
  }

  belongsTo(tenantId: string): boolean {
    return this.props.tenantId === tenantId
  }

  isActive(): boolean {
    return this.props.active
  }

  attributes(): readonly AttributeName[] {
    return this.props.attributes
  }

  toSnapshot(): Readonly<{
    id: string
    tenantId: string
    name: string
    attributes: readonly string[]
    active: boolean
    createdAt: Date
    updatedAt: Date
  }> {
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      name: this.props.name.value,
      attributes: this.props.attributes.map((attribute) => attribute.value),
      active: this.props.active,
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
    })
  }
}

/**
 * What makes two variants of a family the same variant.
 *
 * Built from the answers in the family's own order and case-folded, so "L / Navy" and
 * "l / navy" collide rather than becoming two products nobody can tell apart on a shelf.
 *
 * Separated by the ASCII record and unit separators rather than anything a person might
 * type, so no pair of answers can be spelled to look like another pair. NUL would have
 * been the obvious choice and is the one thing a Postgres text column will not hold.
 */
const BETWEEN_PAIRS = '\u001f'
const BETWEEN_NAME_AND_VALUE = '\u001e'

export function combinationOf(answers: readonly AttributeAnswer[]): string {
  return answers
    .map((answer) => `${answer.attribute.key}${BETWEEN_NAME_AND_VALUE}${answer.value.key}`)
    .join(BETWEEN_PAIRS)
}
