import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { UnitOfMeasure } from '@/domain/entities/unit-of-measure'
import { CatalogName, UnitCode } from '@/domain/value-objects/catalog-values'
import { type AuditContext, auditContext } from '../ports/audit-context'
import type { Clock } from '../ports/clock'
import type { UnitOfWork } from '../ports/unit-of-work'

export class CreateUnitUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}
  async execute(
    request: AuditContext & {
      tenantId: string
      code: string
      name: string
      decimalPlaces: number
    },
  ): Promise<Either<InvalidInputError | ConflictError, { unitId: string }>> {
    const code = UnitCode.create(request.code)
    if (code.isLeft()) return left(code.value)
    const name = CatalogName.create(request.name)
    if (name.isLeft()) return left(name.value)
    if (
      !Number.isInteger(request.decimalPlaces) ||
      request.decimalPlaces < 0 ||
      request.decimalPlaces > 6
    )
      return left(new InvalidInputError('/decimalPlaces', 'must be an integer between 0 and 6'))
    return this.unitOfWork.inTenant(request.tenantId, async (scope) => {
      if (await scope.units.findByCode(code.value.value))
        return left(new ConflictError(`unit code "${code.value.value}" already exists`))
      const unit = UnitOfMeasure.create({
        tenantId: request.tenantId,
        code: code.value,
        name: name.value,
        decimalPlaces: request.decimalPlaces,
        createdAt: this.clock.now(),
      })
      await scope.units.create(unit)
      await scope.audit.append({
        ...auditContext(request),
        action: 'catalog.unit.created',
        subjectType: 'UnitOfMeasure',
        subjectId: unit.id.toString(),
        after: {
          code: code.value.value,
          name: name.value.value,
          decimalPlaces: request.decimalPlaces,
        },
        occurredAt: this.clock.now(),
      })
      return right({ unitId: unit.id.toString() })
    })
  }
}
