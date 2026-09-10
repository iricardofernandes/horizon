import { Injectable } from '@nestjs/common'

import { type Either, right } from '@/core/either'
import { boundedLimit, type Page } from '@/core/repositories/pagination-params'
import type { User } from '@/domain/entities/user'
import type { UnitOfWork } from '../ports/unit-of-work'

export interface ListUsersRequest {
  readonly tenantId: string
  readonly limit?: number
  readonly cursor?: string
}

export type ListUsersResponse = Either<never, Page<User>>

/**
 * Keyset pagination on `(tenant_id, created_at, id)` — the index leads with `tenant_id`,
 * as every composite index in Horizon does (ADR 0017).
 *
 * There is deliberately no total. Counting rows behind an RLS policy is expensive and
 * almost nobody needs an exact figure; the ones who do can have an endpoint built for it.
 */
@Injectable()
export class ListUsersUseCase {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(request: ListUsersRequest): Promise<ListUsersResponse> {
    return this.unitOfWork.inTenant(request.tenantId, async (scope) =>
      right(
        await scope.users.list({
          limit: boundedLimit(request.limit),
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        }),
      ),
    )
  }
}
