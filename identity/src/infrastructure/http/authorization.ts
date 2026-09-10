import { AbilityBuilder, createMongoAbility } from '@casl/ability'
import { roleAssignmentSchema } from '@horizon/contracts'
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
import { InvalidAccessTokenError } from '@/domain/errors/invalid-access-token-error'
import type { IdentityRuntime } from '@/main/identity-runtime'
import type { IdentityHttpRequest } from './http-context'

export const PUBLIC_ROUTE = 'identity:public-route'
export const ROUTE_PERMISSION = 'identity:route-permission'
export const READ_DURING_DENYLIST_OUTAGE = 'identity:read-during-denylist-outage'

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

    const permission = this.reflector.getAllAndOverride<{ action: string; subject: string }>(
      ROUTE_PERMISSION,
      targets,
    )
    if (permission && !abilityFor(claims).can(permission.action, permission.subject))
      throw new ForbiddenException('The assigned Identity role does not permit this operation')

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
    request.principal = claims
    return true
  }
}
