import { SCOPE_REFUSAL_MESSAGE, scopeAllows } from '@horizon/contracts'
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common'
import type { Reflector } from '@nestjs/core'
import type { AccessClaims } from '@/infrastructure/cryptography/access-token-verifier'
import type { SalesRuntime } from '@/main/sales-runtime'

const PUBLIC = 'sales:public'
const ACTION = 'sales:action'
export const PublicRoute = () => SetMetadata(PUBLIC, true)
export const RequireSalesAction = (action: 'read' | 'manage') => SetMetadata(ACTION, action)

export interface SalesRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  principal?: AccessClaims
}

export function tenantOf(request: SalesRequest): string {
  if (!request.principal) throw new UnauthorizedException()
  return request.principal.tenantId
}

/** Who is acting, so a decision can name them and four eyes can be told apart. */
/**
 * Who performed the act, for every performer field and duty check: a key's token counts
 * as its issuer (ADR 0066), so nobody approves what their own agent or integration drafted.
 */
export function actorOf(request: SalesRequest): string {
  if (!request.principal) throw new UnauthorizedException()
  return request.principal.keyIssuer ?? request.principal.subject
}

/** The key an act went through, kept beside the person in the audit entry; null for a person. */
export function viaOf(request: SalesRequest): string | null {
  if (!request.principal) throw new UnauthorizedException()
  return request.principal.keyIssuer ? request.principal.subject : null
}

export class SalesAuthGuard implements CanActivate {
  constructor(
    private readonly runtime: SalesRuntime,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()]
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true
    const request = context.switchToHttp().getRequest<SalesRequest>()
    const authorization = request.headers.authorization
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer '))
      throw new UnauthorizedException()
    try {
      request.principal = await this.runtime.accessTokens.verify(authorization.slice(7))
    } catch {
      throw new UnauthorizedException()
    }
    // A key's scopes before any role (ADR 0064), so a read-only key reads the same everywhere.
    const method = context.switchToHttp().getRequest<{ method?: string }>().method ?? 'POST'
    if (!scopeAllows(request.principal.scopes, 'sales', method))
      throw new ForbiddenException(SCOPE_REFUSAL_MESSAGE)
    const action = this.reflector.getAllAndOverride<'read' | 'manage'>(ACTION, targets)
    if (!action) return true
    const allowed = request.principal.roles.some(
      (assignment) =>
        assignment.module === 'sales' &&
        (assignment.role === 'admin' ||
          (action === 'read' && ['representative', 'viewer'].includes(assignment.role)) ||
          (action === 'manage' && assignment.role === 'representative')),
    )
    if (!allowed) throw new ForbiddenException('The Sales role does not permit this operation')
    return true
  }
}
