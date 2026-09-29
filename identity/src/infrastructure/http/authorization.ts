import { AbilityBuilder, createMongoAbility } from '@casl/ability'
import { roleAssignmentSchema, SCOPE_REFUSAL_MESSAGE, scopeAllows } from '@horizon/contracts'
import {
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Logger,
  ServiceUnavailableException,
  SetMetadata,
} from '@nestjs/common'
import type { Reflector } from '@nestjs/core'
import { ApiBearerAuth, ApiExtension } from '@nestjs/swagger'

import type { VerifiedAccessToken } from '@/application/ports/access-token-signer'
import { recentlyAuthenticated } from '@/application/use-cases/mfa/step-up'
import { InvalidAccessTokenError } from '@/domain/errors/invalid-access-token-error'
import { StepUpRequiredError } from '@/domain/errors/mfa-errors'
import type { IdentityRuntime } from '@/main/identity-runtime'
import type { IdentityHttpRequest } from './http-context'

export const PUBLIC_ROUTE = 'identity:public-route'
export const ROUTE_PERMISSION = 'identity:route-permission'
export const READ_DURING_DENYLIST_OUTAGE = 'identity:read-during-denylist-outage'
export const RECENT_AUTH = 'identity:recent-auth'

/**
 * A sensitive action (ADR 0061 §4): the token must prove a sign-in or step-up within the
 * last ten minutes, with a second factor when the account has one.
 */
export const RequireRecentAuth = () =>
  applyDecorators(SetMetadata(RECENT_AUTH, true), ApiExtension('x-identity-step-up', true))

export const PublicRoute = () => SetMetadata(PUBLIC_ROUTE, true)
export const ReadDuringDenylistOutage = () =>
  applyDecorators(
    SetMetadata(READ_DURING_DENYLIST_OUTAGE, true),
    ApiExtension('x-revocation-store-outage', 'allow-read'),
  )
export const RequirePermission = (action: string, subject: string) =>
  applyDecorators(
    SetMetadata(ROUTE_PERMISSION, { action, subject }),
    ApiBearerAuth(),
    ApiExtension('x-identity-permission', { action, subject }),
  )

/** Each module owns its own expansion; a catalog admin grants no Identity permission. */
function abilityFor(claims: VerifiedAccessToken) {
  const { can, build } = new AbilityBuilder(createMongoAbility)
  for (const assignment of claims.roles) {
    if (assignment.module !== 'identity') continue
    if (assignment.role === 'owner') can('manage', 'all')
    if (assignment.role === 'admin') {
      can('read', 'Users')
      can('read', 'Audit')
      can('read', 'DataSubjects')
    }
    // Reads the audit log and nothing else (Phase 69).
    if (assignment.role === 'auditor') can('read', 'Audit')
  }
  return build()
}

export class IdentityAuthGuard implements CanActivate {
  private readonly logger = new Logger(IdentityAuthGuard.name)

  constructor(
    private readonly runtime: IdentityRuntime,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()]
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, targets)) return true
    const request = context.switchToHttp().getRequest<IdentityHttpRequest>()
    const authorization = request.headers.authorization
    if (typeof authorization !== 'string' || !/^Bearer [^ ]+$/.test(authorization))
      throw new InvalidAccessTokenError()

    const verified = await this.runtime.signer.verify(authorization.slice(7))
    if (verified.isLeft()) throw verified.value
    const claims = verified.value
    if (!roleAssignmentSchema.array().safeParse(claims.roles).success)
      throw new InvalidAccessTokenError()

    const verdicts = await Promise.all([
      this.runtime.denylist.check(claims.jti),
      this.runtime.denylist.checkSubject(claims.subject),
    ])
    if (verdicts.includes('denied')) {
      this.logger.warn({
        event: 'denylist.denied',
        jti: claims.jti,
        reason: verdicts[0] === 'denied' ? 'token-revoked' : 'subject-revoked',
        requestId: request.id,
      })
      throw new InvalidAccessTokenError()
    }
    if (verdicts.includes('unavailable')) {
      const readAllowed = this.reflector.getAllAndOverride<boolean>(
        READ_DURING_DENYLIST_OUTAGE,
        targets,
      )
      if (!readAllowed || !['GET', 'HEAD'].includes(request.method)) {
        this.logger.warn({
          event: 'denylist.denied',
          jti: claims.jti,
          reason: 'store-unavailable',
          requestId: request.id,
        })
        throw new ServiceUnavailableException('Token revocation checks are temporarily unavailable')
      }
      this.logger.warn({
        event: 'denylist.read-allowed-during-outage',
        jti: claims.jti,
        reason: 'store-unavailable',
        requestId: request.id,
      })
    }
    // Revocation is weighed before any role, so a revoked token reads the same everywhere;
    // then a key's scopes, so a read-only key is refused the same way in every module.
    if (!scopeAllows(claims.scopes, 'identity', request.method))
      throw new ForbiddenException(SCOPE_REFUSAL_MESSAGE)
    const permission = this.reflector.getAllAndOverride<{ action: string; subject: string }>(
      ROUTE_PERMISSION,
      targets,
    )
    if (permission && !abilityFor(claims).can(permission.action, permission.subject))
      throw new ForbiddenException('The assigned Identity role does not permit this operation')
    request.principal = claims
    if (this.reflector.getAllAndOverride<boolean>(RECENT_AUTH, targets))
      await this.requireRecentAuth(claims)
    return true
  }

  private async requireRecentAuth(claims: VerifiedAccessToken): Promise<void> {
    // An API key or service token has no account and no sign-in time: it never passes.
    if (!claims.authTime || !/^[0-9a-f-]{36}$/i.test(claims.subject))
      throw new StepUpRequiredError()
    const accountId = await this.runtime.database.accounts.findAccountIdByMembership(
      claims.tenantId,
      claims.subject,
    )
    const hasFactor = accountId
      ? await this.runtime.secondFactors.hasActiveFactor(accountId)
      : false
    if (!recentlyAuthenticated(claims, hasFactor, new Date())) throw new StepUpRequiredError()
  }
}
