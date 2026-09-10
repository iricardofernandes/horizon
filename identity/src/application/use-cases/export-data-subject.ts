import { Injectable } from '@nestjs/common'

import { type Either, left, right } from '@/core/either'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import type { ApiKey } from '@/domain/entities/api-key'
import type { User } from '@/domain/entities/user'
import { SubjectErasedError } from '@/domain/errors/subject-erased-error'
import type { UnitOfWork } from '../ports/unit-of-work'

export interface ExportDataSubjectRequest {
  readonly tenantId: string
  readonly subjectId: string
}

export interface DataSubjectExport {
  readonly user: User
  readonly apiKeys: readonly ApiKey[]
}

export type ExportDataSubjectResponse = Either<
  ResourceNotFoundError | SubjectErasedError,
  DataSubjectExport
>

/**
 * Everything this module holds about one data subject — the access right that accompanies
 * the erasure right (ADR 0026).
 *
 * It returns aggregates, not a rendered document: turning them into a response body is a
 * presenter's job, and keeping the split means the same export can later be produced as
 * JSON, as a download, or into a support tool without duplicating what "everything" means.
 *
 * An already-erased subject gets `SubjectErasedError`, not a 404. The row is right there;
 * saying "not found" would be a lie, and a 500 would suggest something is broken. Erasure
 * worked — that is what the error says.
 */
@Injectable()
export class ExportDataSubjectUseCase {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(request: ExportDataSubjectRequest): Promise<ExportDataSubjectResponse> {
    return this.unitOfWork.inTenant<ExportDataSubjectResponse>(request.tenantId, async (scope) => {
      const user = await scope.users.findById(request.subjectId)
      if (user === null) return left(new ResourceNotFoundError('data subject'))
      if (user.isErased()) return left(new SubjectErasedError())

      const apiKeys = await scope.apiKeys.listIssuedBy(request.subjectId)
      return right({ user, apiKeys })
    })
  }
}
