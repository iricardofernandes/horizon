import { Injectable } from '@nestjs/common'

import { type Either, left, right } from '@/core/either'
import type { ConflictError } from '@/core/errors/errors/conflict-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import type { Actor } from '@/domain/audit/audit-entry'
import type { RefreshTokenFamiliesRepository } from '@/domain/repositories/refresh-token-families-repository'
import type { Clock } from '../ports/clock'
import type { IdentityPolicy } from '../ports/identity-policy'
import type { TokenDenylist } from '../ports/token-denylist'
import type { UnitOfWork } from '../ports/unit-of-work'

export interface EraseDataSubjectRequest {
  readonly tenantId: string
  readonly subjectId: string
  readonly actor: Actor
  readonly requestId?: string | null
}

export type EraseDataSubjectResponse = Either<ResourceNotFoundError | ConflictError, null>

/**
 * LGPD Art. 18 / GDPR Art. 17 erasure, by destroying the key rather than the rows
 * (ADR 0026).
 *
 * Nothing is deleted. The user row stays, every audit entry stays, and the ciphertext in
 * both stays byte for byte where it was — so the hash chain still verifies, because
 * nothing it hashed has changed. What is destroyed is the per-subject key, and with it
 * any possibility of reading the plaintext, by anyone, including whoever operates this
 * system.
 *
 * It reaches backups, which a `DELETE` cannot: last night's backup holds ciphertext whose
 * key exists nowhere any more, so restoring it resurrects nothing. That is the property
 * that makes this the right answer rather than a clever one.
 *
 * What survives is the *shape* of history — that a user existed, that actions occurred at
 * times, that records changed — with the personal content cryptographically gone. The
 * `data-subject.erased` event tells every other module to shred its own copies.
 */
@Injectable()
export class EraseDataSubjectUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly families: RefreshTokenFamiliesRepository,
    private readonly denylist: TokenDenylist,
    private readonly policy: IdentityPolicy,
    private readonly clock: Clock,
  ) {}

  async execute(request: EraseDataSubjectRequest): Promise<EraseDataSubjectResponse> {
    const now = this.clock.now()

    const outcome = await this.unitOfWork.inTenant<EraseDataSubjectResponse>(
      request.tenantId,
      async (scope) => {
        const user = await scope.users.findById(request.subjectId)
        if (user === null) return left(new ResourceNotFoundError('data subject'))

        const key = await scope.dataSubjectKeys.findBySubject(request.subjectId)
        if (key === null) return left(new ResourceNotFoundError('data subject key'))

        const destroyed = key.destroy(now)
        if (destroyed.isLeft()) return left(destroyed.value)

        const marked = user.markErased(now)
        if (marked.isLeft()) return left(marked.value)

        // Order matters within the transaction only in that both must be in it. The
        // audit entry is written *before* the key row is saved so that the entry's own
        // diff — which names no personal data — is chained ahead of the erasure, leaving
        // a readable record that an erasure happened at all.
        await scope.audit.append({
          actor: request.actor,
          subjectType: 'data-subject',
          subjectId: request.subjectId,
          action: 'data-subject.erased',
          requestId: request.requestId ?? null,
          occurredAt: now,
        })
        await scope.dataSubjectKeys.save(key)
        await scope.users.save(user)
        await scope.outbox.publish(key.pullDomainEvents())

        return right(null)
      },
    )

    if (outcome.isLeft()) return outcome

    await this.endEverySession(request, now)
    return right(null)
  }

  /** An erased subject cannot still be holding a live session. */
  private async endEverySession(request: EraseDataSubjectRequest, now: Date): Promise<void> {
    const families = await this.families.findAllForUser(request.tenantId, request.subjectId)
    for (const family of families)
      await this.families.delete(request.tenantId, family.id.toString())

    await this.denylist.revokeSubject(
      request.subjectId,
      new Date(now.getTime() + this.policy.accessTokenTtlSeconds() * 1000),
    )
  }
}
