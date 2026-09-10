import { Injectable } from '@nestjs/common'

import { type Either, right } from '@/core/either'
import { boundedLimit, type Page } from '@/core/repositories/pagination-params'
import type { ApiKey } from '@/domain/entities/api-key'
import type { UnitOfWork } from '../ports/unit-of-work'

export interface ListApiKeysRequest {
  readonly tenantId: string
  readonly limit?: number
  readonly cursor?: string
}

export type ListApiKeysResponse = Either<never, Page<ApiKey>>

/** Keys are listed by prefix and metadata. There is no code path that returns a secret. */
@Injectable()
export class ListApiKeysUseCase {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(request: ListApiKeysRequest): Promise<ListApiKeysResponse> {
    return this.unitOfWork.inTenant(request.tenantId, async (scope) =>
      right(
        await scope.apiKeys.list({
          limit: boundedLimit(request.limit),
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        }),
      ),
    )
  }
}
