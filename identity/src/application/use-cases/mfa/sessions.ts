import { type Either, left, right } from '@/core/either'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import type { Actor } from '@/domain/audit/audit-entry'
import type { RefreshTokenFamiliesRepository } from '@/domain/repositories/refresh-token-families-repository'
import type { Clock } from '../../ports/clock'
import type { SessionRegistry } from '../../ports/mfa'
import type { TokenDenylist } from '../../ports/token-denylist'
import type { UnitOfWork } from '../../ports/unit-of-work'

export interface SessionView {
  readonly id: string
  readonly device: string
  readonly ipPrefix: string | null
  readonly secondFactor: boolean
  readonly createdAt: Date
  readonly lastUsedAt: Date
  readonly current: boolean
}

/**
 * Sessions a person can see and end (ADR 0061 §5). Ending one deletes its refresh family,
 * so nothing new is minted, and denylists every access token it issued that is still alive,
 * so the ones already in hand stop working too.
 */
export class SessionsUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly families: RefreshTokenFamiliesRepository,
    private readonly registry: SessionRegistry,
    private readonly denylist: TokenDenylist,
    private readonly clock: Clock,
  ) {}

  async list(tenantId: string, userId: string, currentSid: string | null): Promise<SessionView[]> {
    const families = await this.families.findAllForUser(tenantId, userId)
    const views = await Promise.all(
      families.map(async (family) => {
        const id = family.id.toString()
        const meta = await this.registry.find(tenantId, id)
        return {
          id,
          device: meta?.device ?? 'Unknown device',
          ipPrefix: meta?.ipPrefix ?? null,
          secondFactor: (meta?.amr ?? []).some((method) => method !== 'pwd'),
          createdAt: meta?.createdAt ?? family.createdAt(),
          lastUsedAt: meta?.lastUsedAt ?? family.lastUsedAt(),
          current: id === currentSid,
        }
      }),
    )
    return views.sort((a, b) => b.lastUsedAt.getTime() - a.lastUsedAt.getTime())
  }

  /** One of the person's own sessions, or one of a user's for an administrator. */
  async end(
    tenantId: string,
    userId: string,
    familyId: string,
    actor: Actor,
    requestId: string | null,
  ): Promise<Either<ResourceNotFoundError, { ended: number }>> {
    const family = await this.families.findById(tenantId, familyId)
    if (family === null || family.userId() !== userId)
      return left(new ResourceNotFoundError('session'))
    const tokens = await this.kill(tenantId, familyId)
    await this.audit(tenantId, actor, userId, [familyId], tokens, requestId)
    return right({ ended: 1 })
  }

  /** Every session of a user but `keep` (the one asking), or all of them. */
  async endAll(
    tenantId: string,
    userId: string,
    keep: string | null,
    actor: Actor,
    requestId: string | null,
  ): Promise<{ ended: number }> {
    const families = await this.families.findAllForUser(tenantId, userId)
    const ended: string[] = []
    let tokens = 0
    for (const family of families) {
      const id = family.id.toString()
      if (id === keep) continue
      tokens += await this.kill(tenantId, id)
      ended.push(id)
    }
    if (ended.length > 0) await this.audit(tenantId, actor, userId, ended, tokens, requestId)
    return { ended: ended.length }
  }

  private async kill(tenantId: string, familyId: string): Promise<number> {
    const now = this.clock.now()
    const live = await this.registry.liveTokens(tenantId, familyId, now)
    await this.families.delete(tenantId, familyId)
    for (const token of live) await this.denylist.revoke(token.jti, token.expiresAt)
    await this.registry.forget(tenantId, familyId)
    return live.length
  }

  private async audit(
    tenantId: string,
    actor: Actor,
    userId: string,
    familyIds: readonly string[],
    tokens: number,
    requestId: string | null,
  ): Promise<void> {
    const now = this.clock.now()
    await this.unitOfWork.inTenant(tenantId, async (scope) => {
      for (const familyId of familyIds)
        await scope.audit.append({
          actor,
          subjectType: 'session',
          subjectId: familyId,
          action: 'session.revoked',
          dataSubjectId: userId,
          after: { user: userId, liveTokensDenied: tokens },
          requestId,
          occurredAt: now,
        })
    })
  }
}
