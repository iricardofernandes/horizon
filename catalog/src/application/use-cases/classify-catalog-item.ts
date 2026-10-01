import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { EffectiveDate, NcmCode } from '@/domain/value-objects/catalog-values'
import { type AuditContext, auditContext } from '../ports/audit-context'
import type { Clock } from '../ports/clock'
import type { UnitOfWork } from '../ports/unit-of-work'

export class ClassifyCatalogItemUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(
    request: AuditContext & {
      tenantId: string
      itemId: string
      effectiveFrom: string
      ncm: string | null
      /** Absent keeps what the item's classification said (Phase 89). */
      ipiTaxpayer?: boolean | undefined
    },
  ): Promise<
    Either<InvalidInputError | ConflictError | ResourceNotFoundError, { revision: number }>
  > {
    const date = EffectiveDate.create(request.effectiveFrom)
    if (date.isLeft()) return left(date.value)
    const ncm =
      request.ncm === null ? right<InvalidInputError, null>(null) : NcmCode.create(request.ncm)
    if (ncm.isLeft()) return left(ncm.value)
    return this.unitOfWork.inTenant(request.tenantId, async (scope) => {
      const item = await scope.items.findById(request.itemId)
      if (!item) return left(new ResourceNotFoundError('catalog item'))
      const before = { ncm: item.ncmCode(), ipiTaxpayer: item.ipiTaxpayer }
      const result = item.classify(
        ncm.value,
        date.value.value,
        this.clock.now(),
        request.ipiTaxpayer ?? item.ipiTaxpayer,
      )
      if (result.isLeft()) return left(result.value)
      await scope.items.save(item)
      await scope.audit.append({
        ...auditContext(request),
        action: 'catalog.item.classification-changed',
        subjectType: 'CatalogItem',
        subjectId: request.itemId,
        before,
        after: {
          ncm: ncm.value?.value ?? null,
          ipiTaxpayer: item.ipiTaxpayer,
          revision: result.value,
          effectiveFrom: date.value.value,
        },
        occurredAt: this.clock.now(),
      })
      return right({ revision: result.value })
    })
  }
}
