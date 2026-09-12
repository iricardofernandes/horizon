import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { type AuditContext, auditContext } from '../ports/audit-context'
import type { Clock } from '../ports/clock'
import type { UnitOfWork } from '../ports/unit-of-work'

export class DeactivateCatalogItemUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}
  async execute(
    request: AuditContext & { tenantId: string; itemId: string },
  ): Promise<Either<ConflictError | ResourceNotFoundError, void>> {
    return this.unitOfWork.inTenant(request.tenantId, async (scope) => {
      const item = await scope.items.findById(request.itemId)
      if (!item) return left(new ResourceNotFoundError('catalog item'))
      const result = item.deactivate(this.clock.now())
      if (result.isLeft()) return left(result.value)
      await scope.items.save(item)
      await scope.audit.append({
        ...auditContext(request),
        action: 'catalog.item.deactivated',
        subjectType: 'CatalogItem',
        subjectId: item.id.toString(),
        before: { active: true },
        after: { active: false },
        occurredAt: this.clock.now(),
      })
      return right(undefined)
    })
  }
}
