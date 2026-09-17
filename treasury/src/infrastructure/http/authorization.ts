import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common'
import type { Reflector } from '@nestjs/core'
import type { AccessClaims } from '@/infrastructure/cryptography/access-token-verifier'
import type { TreasuryRuntime } from '@/main/treasury-runtime'

const PUBLIC = 'treasury:public'
const ACTION = 'treasury:action'
export type TreasuryAction = 'read' | 'configure' | 'record' | 'reverse'
export const PublicRoute = () => SetMetadata(PUBLIC, true)
export const RequireTreasuryAction = (action: TreasuryAction) => SetMetadata(ACTION, action)

export interface TreasuryRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  principal?: AccessClaims
}

export function actorOf(request: TreasuryRequest): string {
  if (!request.principal) throw new UnauthorizedException()
  return request.principal.subject
}

export function tenantOf(request: TreasuryRequest): string {
  if (!request.principal) throw new UnauthorizedException()
  return request.principal.tenantId
}

/**
 * The static role map for this module (ADR 0023). Opening and closing accounts changes where
 * money may be recorded, so it is admin-only. Operators record entries and transfers.
 * Reversing an entry or cancelling a transfer undoes a movement others may have acted on,
 * so it stays with admins (ADR 0042).
 */
const PERMITS: Readonly<Record<string, readonly TreasuryAction[]>> = {
  admin: ['read', 'configure', 'record', 'reverse'],
  operator: ['read', 'record'],
  viewer: ['read'],
}

export class TreasuryAuthGuard implements CanActivate {
  constructor(
    private readonly runtime: TreasuryRuntime,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()]
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true
    const request = context.switchToHttp().getRequest<TreasuryRequest>()
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
    const action = this.reflector.getAllAndOverride<TreasuryAction>(ACTION, targets)
    if (!action) return true
    const allowed = principal.roles.some(
      (assignment) =>
        assignment.module === 'treasury' && (PERMITS[assignment.role]?.includes(action) ?? false),
    )
    if (!allowed) throw new ForbiddenException('The Treasury role does not permit this operation')
    return true
  }
}
