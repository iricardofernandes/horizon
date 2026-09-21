import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { type ComponentLine, Composition, type Realisation } from '@/domain/entities/composition'
import { ComponentQuantity, EffectiveDate } from '@/domain/value-objects/catalog-values'
import { type AuditContext, auditContext } from '../ports/audit-context'
import type { Clock } from '../ports/clock'
import type { TenantScope, UnitOfWork } from '../ports/unit-of-work'

type Failure = InvalidInputError | ConflictError | ResourceNotFoundError

/**
 * What an item is made of, from a date.
 *
 * Never an edit. A recipe changes and the goods made under the old one have to stay
 * explicable: a production order that consumed four of something is not wrong because the
 * recipe now says three. So this always writes a new version, and the one in force on any
 * day is the latest whose date has arrived.
 *
 * The check nobody can do alone is the cycle. A chair made of legs is fine; a chair made
 * of legs made of chairs is a catalogue that cannot answer what anything costs or how
 * long anything takes. The parent refuses to list itself, this walks the graph before
 * writing so the person is told *which* component closes the loop, and a trigger asks
 * again for the two people who define halves of a cycle at the same moment.
 */
export class DefineCompositionUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(
    request: AuditContext & {
      tenantId: string
      parentItemId: string
      realisation: Realisation
      effectiveFrom: string
      lines: readonly { componentItemId: string; quantity: string }[]
    },
  ): Promise<Either<Failure, { compositionId: string; version: number }>> {
    const effectiveFrom = EffectiveDate.create(request.effectiveFrom)
    if (effectiveFrom.isLeft()) return left(effectiveFrom.value)
    const lines: ComponentLine[] = []
    for (const [index, line] of request.lines.entries()) {
      const quantity = ComponentQuantity.create(line.quantity, `/lines/${index}/quantity`)
      if (quantity.isLeft()) return left(quantity.value)
      lines.push({ componentItemId: line.componentItemId, quantity: quantity.value })
    }

    return this.unitOfWork.inTenant(request.tenantId, async (scope) => {
      const parent = await scope.items.findById(request.parentItemId)
      if (!parent?.isActive()) return left(new ResourceNotFoundError('active catalog item'))
      // Only a product is made of anything. A service is delivered rather than assembled,
      // and a bundle of services is a contract, which is a different module's problem.
      if (parent.kind() !== 'product')
        return left(new ConflictError('only a product is made of other things'))

      const components = await this.checkComponents(scope, request.parentItemId, lines)
      if (components.isLeft()) return left(components.value)

      const latest = await scope.compositions.latest(request.parentItemId)
      // Versions march forward in time as well as in number: a version that took effect
      // before the one it supersedes would leave two answers in force on the same day.
      if (latest && effectiveFrom.value.isBefore(latest.effectiveFrom()))
        return left(
          new ConflictError('a new version takes effect no earlier than the one it supersedes'),
        )

      const now = this.clock.now()
      const composition = Composition.define({
        tenantId: request.tenantId,
        parentItemId: request.parentItemId,
        version: (latest?.version() ?? 0) + 1,
        realisation: request.realisation,
        effectiveFrom: effectiveFrom.value,
        lines,
        // The named principal, or `system` for a job that has none to name.
        definedBy: request.actor.id ?? request.actor.type,
        now,
      })
      if (composition.isLeft()) return left(composition.value)

      await scope.compositions.create(composition.value)
      await scope.audit.append({
        ...auditContext(request),
        action: 'catalog.composition.defined',
        subjectType: 'Composition',
        subjectId: composition.value.id.toString(),
        after: {
          parentItemId: request.parentItemId,
          version: composition.value.version(),
          realisation: request.realisation,
          effectiveFrom: effectiveFrom.value.value,
          lines: lines.map((line) => ({
            componentItemId: line.componentItemId,
            quantity: line.quantity.toString(),
          })),
        },
        occurredAt: now,
      })
      return right({
        compositionId: composition.value.id.toString(),
        version: composition.value.version(),
      })
    })
  }

  /** Every component exists, is in use, and is not made of the parent somewhere below. */
  private async checkComponents(
    scope: TenantScope,
    parentItemId: string,
    lines: readonly ComponentLine[],
  ): Promise<Either<Failure, void>> {
    for (const line of lines) {
      const component = await scope.items.findById(line.componentItemId)
      if (!component?.isActive())
        return left(new ResourceNotFoundError(`active component ${line.componentItemId}`))
      if (await scope.compositions.reaches(line.componentItemId, parentItemId))
        return left(
          new ConflictError(
            `component ${line.componentItemId} is itself made of this item, which would make it part of itself`,
          ),
        )
    }
    return right(undefined)
  }
}
