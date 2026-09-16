import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common'
import type { Reflector } from '@nestjs/core'
import type { AccessClaims } from '@/infrastructure/cryptography/access-token-verifier'
import type { FinancialRuntime } from '@/main/financial-runtime'

const PUBLIC = 'financial:public'
const ACTION = 'financial:action'
export type FinancialAction = 'read' | 'configure' | 'record' | 'reverse'
export const PublicRoute = () => SetMetadata(PUBLIC, true)
export const RequireFinancialAction = (action: FinancialAction) => SetMetadata(ACTION, action)

export interface FinancialRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  principal?: AccessClaims
}

export function actorOf(request: FinancialRequest): string {
  if (!request.principal) throw new UnauthorizedException()
  return request.principal.subject
}

export function tenantOf(request: FinancialRequest): string {
  if (!request.principal) throw new UnauthorizedException()
  return request.principal.tenantId
}

/**
 * The static role map for this module (ADR 0023). Configuring the chart of categories,
 * dimensions and terms changes how every later title is classified, so it is admin-only.
 * Operators draft, post and settle titles. Reversing something already posted or settled
 * undoes a fact other contexts acted on, so it stays with admins (ADR 0042).
 */
const PERMITS: Readonly<Record<string, readonly FinancialAction[]>> = {
  admin: ['read', 'configure', 'record', 'reverse'],
  operator: ['read', 'record'],
  viewer: ['read'],
}

export class FinancialAuthGuard implements CanActivate {
  constructor(
    private readonly runtime: FinancialRuntime,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()]
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true
    const request = context.switchToHttp().getRequest<FinancialRequest>()
    const authorization = request.headers.authorization
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer '))
      throw new UnauthorizedException()
    let principal: AccessClaims
    try {
      principal = await this.runtime.accessTokens.verify(authorization.slice(7))
    } catch {
      throw new UnauthorizedException()
    }
    request.principal = principal
    const action = this.reflector.getAllAndOverride<FinancialAction>(ACTION, targets)
    if (!action) return true
    const allowed = principal.roles.some(
      (assignment) =>
        assignment.module === 'financial' && (PERMITS[assignment.role]?.includes(action) ?? false),
    )
    if (!allowed) throw new ForbiddenException('The Financial role does not permit this operation')
    return true
  }
}
