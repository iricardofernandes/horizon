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
import { InvalidAccessTokenError } from '@/core/errors/errors/invalid-access-token-error'
import {
  AccessTokenVerificationUnavailableError,
  type VerifiedAccessToken,
} from '@/infrastructure/cryptography/jwks-access-token-verifier'
import type { CatalogRuntime } from '@/main/catalog-runtime'
import type { CatalogHttpRequest } from './http-context'

export const PUBLIC_ROUTE = 'catalog:public-route'
export const ROUTE_PERMISSION = 'catalog:route-permission'
export const READ_DURING_DENYLIST_OUTAGE = 'catalog:read-during-denylist-outage'

export const PublicRoute = () => SetMetadata(PUBLIC_ROUTE, true)

/**
 * The read that may proceed while revocation checks are down (ADR 0021). It is declared
 * per handler and published in OpenAPI, never inferred from the verb at runtime.
 */
export const ReadDuringDenylistOutage = () =>
  applyDecorators(
    SetMetadata(READ_DURING_DENYLIST_OUTAGE, true),
    ApiExtension('x-revocation-store-outage', 'allow-read'),
  )

export const RequirePermission = (action: string, subject: string) =>
  applyDecorators(
    SetMetadata(ROUTE_PERMISSION, { action, subject }),
    ApiBearerAuth(),
    ApiExtension('x-catalog-permission', { action, subject }),
  )

/**
 * Catalog's own expansion of Catalog's own role names (ADR 0023). Identity stores
 * opaque `{ module, role }` pairs and cannot expand them; an `identity` admin — or a
 * `sales` one — receives nothing here.
 *
 * The split is structure versus contents: which units of measure and price lists exist
 * is an administrative decision, what the catalogue holds and what it costs is daily
 * work, and a viewer reads.
 */
function abilityFor(claims: VerifiedAccessToken) {
  const { can, build } = new AbilityBuilder(createMongoAbility)
  for (const assignment of claims.roles) {
    if (assignment.module !== 'catalog') continue
    if (assignment.role === 'admin') can('manage', 'all')
    if (assignment.role === 'editor') {
      can('read', 'Units')
      can('read', 'Items')
      can('read', 'PriceLists')
      can('manage', 'Items')
      can('manage', 'Prices')
    }
    if (assignment.role === 'viewer') {
      can('read', 'Units')
      can('read', 'Items')
      can('read', 'PriceLists')
    }
  }
  return build()
}

export class CatalogAuthGuard implements CanActivate {
  private readonly logger = new Logger(CatalogAuthGuard.name)

  constructor(
    private readonly runtime: CatalogRuntime,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()]
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, targets)) return true
    const request = context.switchToHttp().getRequest<CatalogHttpRequest>()
    const authorization = request.headers.authorization
    if (typeof authorization !== 'string' || !/^Bearer [^ ]+$/.test(authorization))
      throw new InvalidAccessTokenError()

    const verified = await this.verify(authorization.slice(7))
    if (verified.isLeft()) throw verified.value
    const claims = verified.value
    if (!roleAssignmentSchema.array().safeParse(claims.roles).success)
      throw new InvalidAccessTokenError()

    const permission = this.reflector.getAllAndOverride<{ action: string; subject: string }>(
      ROUTE_PERMISSION,
      targets,
    )
    if (permission && !abilityFor(claims).can(permission.action, permission.subject))
      throw new ForbiddenException('The assigned Catalog role does not permit this operation')

    await this.assertNotRevoked(claims, request, targets)
    request.principal = claims
    return true
  }

  private async verify(token: string) {
    try {
      return await this.runtime.accessTokens.verify(token)
    } catch (error) {
      if (error instanceof AccessTokenVerificationUnavailableError) {
        this.logger.error({ event: 'jwks.unavailable' })
        throw new ServiceUnavailableException('Token signing keys are temporarily unavailable')
      }
      throw error
    }
  }

  private async assertNotRevoked(
    claims: VerifiedAccessToken,
    request: CatalogHttpRequest,
    targets: Parameters<Reflector['getAllAndOverride']>[1],
  ): Promise<void> {
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
    if (!verdicts.includes('unavailable')) return

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
}
