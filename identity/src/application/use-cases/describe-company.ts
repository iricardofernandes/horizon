import { Injectable } from '@nestjs/common'

import { type Either, left, right } from '@/core/either'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import type { Actor } from '@/domain/audit/audit-entry'
import type { Tenant } from '@/domain/entities/tenant'
import { CompanyProfile, type CompanyProfileInput } from '@/domain/value-objects/company-profile'
import { Timezone } from '@/domain/value-objects/timezone'
import type { Clock } from '../ports/clock'
import type { UnitOfWork } from '../ports/unit-of-work'

export interface DescribeCompanyRequest {
  readonly tenantId: string
  readonly company: CompanyProfileInput
  readonly timezone: string
  readonly fiscalEffectiveFrom?: string | undefined
  readonly actor: Actor
  readonly requestId?: string | null
}

export type DescribeCompanyResponse = Either<
  InvalidInputError | ResourceNotFoundError,
  { readonly tenant: Tenant }
>

/**
 * Describe who the workspace legally is, and where and in what currency it operates.
 *
 * Timezone travels with the company rather than with the reader: a report covering "last
 * month" means the company's month, whatever language it is read in (ADR 0011, ADR 0044).
 */
@Injectable()
export class DescribeCompanyUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: DescribeCompanyRequest): Promise<DescribeCompanyResponse> {
    const company = CompanyProfile.create(request.company)
    if (company.isLeft()) return left(company.value)

    const timezone = Timezone.create(request.timezone)
    if (timezone.isLeft()) return left(timezone.value)

    const now = this.clock.now()
    const effectiveFrom = request.fiscalEffectiveFrom ?? now.toISOString().slice(0, 10)
    const parsedDate = new Date(`${effectiveFrom}T00:00:00Z`)
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom) ||
      Number.isNaN(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== effectiveFrom
    )
      return left(new InvalidInputError('/fiscalEffectiveFrom', 'must be a calendar date'))
    return this.unitOfWork.inTenant(request.tenantId, async (scope) => {
      const tenant = await scope.tenants.findById(request.tenantId)
      if (tenant === null) return left(new ResourceNotFoundError('workspace'))
      const previous = tenant.fiscalProfileEffectiveFrom()
      if (previous !== null && effectiveFrom < previous)
        return left(
          new InvalidInputError(
            '/fiscalEffectiveFrom',
            'cannot predate the current fiscal profile',
          ),
        )

      tenant.describeCompany(company.value, effectiveFrom, now)
      tenant.moveTo(timezone.value, now)
      await scope.tenants.save(tenant)
      await scope.audit.append({
        actor: request.actor,
        subjectType: 'tenant',
        subjectId: request.tenantId,
        action: 'workspace.company.described',
        dataSubjectId: null,
        requestId: request.requestId ?? null,
        occurredAt: now,
      })
      return right({ tenant })
    })
  }
}

export interface ReadWorkspaceRequest {
  readonly tenantId: string
}

export type ReadWorkspaceResponse = Either<ResourceNotFoundError, { readonly tenant: Tenant }>

/** Every member may read the workspace they are in; only an owner may describe it. */
@Injectable()
export class ReadWorkspaceUseCase {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(request: ReadWorkspaceRequest): Promise<ReadWorkspaceResponse> {
    return this.unitOfWork.inTenant(request.tenantId, async (scope) => {
      const tenant = await scope.tenants.findById(request.tenantId)
      return tenant === null ? left(new ResourceNotFoundError('workspace')) : right({ tenant })
    })
  }
}
