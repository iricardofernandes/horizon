import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { CatalogItem, type CatalogItemKind } from '@/domain/entities/catalog-item'
import { CatalogName, NcmCode, Sku } from '@/domain/value-objects/catalog-values'
import { type AuditContext, auditContext } from '../ports/audit-context'
import type { Clock } from '../ports/clock'
import type { UnitOfWork } from '../ports/unit-of-work'

type Error = InvalidInputError | ConflictError | ResourceNotFoundError
export class CreateCatalogItemUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}
  async execute(
    request: AuditContext & {
      tenantId: string
      kind: CatalogItemKind
      sku: string
      name: string
      unitId: string
      ncm?: string | null
    },
  ): Promise<Either<Error, { itemId: string }>> {
    const sku = Sku.create(request.sku)
    if (sku.isLeft()) return left(sku.value)
    const name = CatalogName.create(request.name)
    if (name.isLeft()) return left(name.value)
    const ncm = request.ncm ? NcmCode.create(request.ncm) : right<InvalidInputError, null>(null)
    if (ncm.isLeft()) return left(ncm.value)
    return this.unitOfWork.inTenant(request.tenantId, async (scope) => {
      const unit = await scope.units.findById(request.unitId)
      if (!unit?.isActive()) return left(new ResourceNotFoundError('active unit of measure'))
      if (await scope.items.findBySku(sku.value.value))
        return left(new ConflictError(`SKU "${sku.value.value}" already exists`))
      const item = CatalogItem.register({
        tenantId: request.tenantId,
        kind: request.kind,
        sku: sku.value,
        name: name.value,
        unitId: request.unitId,
        ncm: ncm.value,
        now: this.clock.now(),
      })
      await scope.items.create(item)
      await scope.audit.append({
        ...auditContext(request),
        action: 'catalog.item.created',
        subjectType: 'CatalogItem',
        subjectId: item.id.toString(),
        after: {
          kind: request.kind,
          sku: sku.value.value,
          name: name.value.value,
          unitId: request.unitId,
          ncm: ncm.value?.value ?? null,
        },
        occurredAt: this.clock.now(),
      })
      return right({ itemId: item.id.toString() })
    })
  }
}
