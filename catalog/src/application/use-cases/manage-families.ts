import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import {
  type AttributeAnswer,
  combinationOf,
  ProductFamily,
} from '@/domain/entities/product-family'
import { AttributeName, AttributeValue, CatalogName } from '@/domain/value-objects/catalog-values'
import { type AuditContext, auditContext } from '../ports/audit-context'
import type { Clock } from '../ports/clock'
import type { UnitOfWork } from '../ports/unit-of-work'

type Failure = InvalidInputError | ConflictError | ResourceNotFoundError

/**
 * A family says that these forty shirts are one shirt in forty combinations.
 *
 * Its axes are named and ordered here and not changed afterwards: a family that gained a
 * third axis would leave every variant already in it unable to answer, and one that lost
 * an axis would make two variants that used to differ identical. A workspace that got it
 * wrong defines another family and moves nothing — which is refused too, and deliberately.
 */
export class DefineProductFamilyUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(
    request: AuditContext & {
      tenantId: string
      name: string
      attributes: readonly string[]
    },
  ): Promise<Either<Failure, { familyId: string }>> {
    const name = CatalogName.create(request.name)
    if (name.isLeft()) return left(name.value)
    const attributes: AttributeName[] = []
    for (const [index, attribute] of request.attributes.entries()) {
      const parsed = AttributeName.create(attribute, `/attributes/${index}`)
      if (parsed.isLeft()) return left(parsed.value)
      attributes.push(parsed.value)
    }

    return this.unitOfWork.inTenant(request.tenantId, async (scope) => {
      if (await scope.families.findByName(name.value.value))
        return left(new ConflictError(`a family named "${name.value.value}" already exists`))
      const now = this.clock.now()
      const family = ProductFamily.define({
        tenantId: request.tenantId,
        name: name.value,
        attributes,
        now,
      })
      if (family.isLeft()) return left(family.value)
      await scope.families.create(family.value)
      await scope.audit.append({
        ...auditContext(request),
        action: 'catalog.family.defined',
        subjectType: 'ProductFamily',
        subjectId: family.value.id.toString(),
        after: {
          name: name.value.value,
          attributes: attributes.map((attribute) => attribute.value),
        },
        occurredAt: now,
      })
      return right({ familyId: family.value.id.toString() })
    })
  }
}

/**
 * An item takes its place in a family, as one combination of its attributes.
 *
 * The combination must be free: two variants that answered every axis the same way are
 * the same variant, and a catalogue holding both would be offering a choice between two
 * things nobody could tell apart. The item cannot see its siblings, so the question is
 * asked here — and a unique index refuses it again, for the two people who ask at once.
 */
export class AssignVariantUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(
    request: AuditContext & {
      tenantId: string
      itemId: string
      familyId: string
      values: readonly { attribute: string; value: string }[]
    },
  ): Promise<Either<Failure, { itemId: string; combination: string }>> {
    const answers: AttributeAnswer[] = []
    for (const [index, given] of request.values.entries()) {
      const attribute = AttributeName.create(given.attribute, `/values/${index}/attribute`)
      if (attribute.isLeft()) return left(attribute.value)
      const value = AttributeValue.create(given.value, `/values/${index}/value`)
      if (value.isLeft()) return left(value.value)
      answers.push({ attribute: attribute.value, value: value.value })
    }

    return this.unitOfWork.inTenant(request.tenantId, async (scope) => {
      const family = await scope.families.findById(request.familyId)
      if (!family) return left(new ResourceNotFoundError('product family'))
      const item = await scope.items.findById(request.itemId)
      if (!item) return left(new ResourceNotFoundError('catalog item'))

      const accepted = family.accept(answers)
      if (accepted.isLeft()) return left(accepted.value)
      const combination = combinationOf(accepted.value)
      if (await scope.families.combinationTaken(request.familyId, combination, request.itemId))
        return left(
          new ConflictError('another item in this family already answers the attributes this way'),
        )

      const now = this.clock.now()
      const assigned = item.assignTo(request.familyId, accepted.value, now)
      if (assigned.isLeft()) return left(assigned.value)
      await scope.items.save(item)
      await scope.audit.append({
        ...auditContext(request),
        action: 'catalog.variant.assigned',
        subjectType: 'CatalogItem',
        subjectId: request.itemId,
        after: {
          familyId: request.familyId,
          values: accepted.value.map((answer) => ({
            attribute: answer.attribute.value,
            value: answer.value.value,
          })),
        },
        occurredAt: now,
      })
      return right({ itemId: request.itemId, combination })
    })
  }
}
