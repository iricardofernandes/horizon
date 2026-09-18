import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common'
import type { Reflector } from '@nestjs/core'
import type { AccessClaims } from '@/infrastructure/cryptography/access-token-verifier'
import type { ProcurementRuntime } from '@/main/procurement-runtime'

const PUBLIC = 'procurement:public'
const ACTION = 'procurement:action'
export type ProcurementAction = 'read' | 'write' | 'commit' | 'decide' | 'configure'
export const PublicRoute = () => SetMetadata(PUBLIC, true)
export const RequireProcurementAction = (action: ProcurementAction) => SetMetadata(ACTION, action)

export interface ProcurementRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  principal?: AccessClaims
}

export function actorOf(request: ProcurementRequest): string {
  if (!request.principal) throw new UnauthorizedException()
  return request.principal.subject
}

export function tenantOf(request: ProcurementRequest): string {
  if (!request.principal) throw new UnauthorizedException()
  return request.principal.tenantId
}

/**
 * The static role map for this module (ADR 0023).
 *
 * The split that matters is `commit` against `decide`: a buyer writes requisitions,
 * records what suppliers answered, chooses between them and places the order; an approver
 * decides whether the company will stand behind it. Giving one person both is a workspace
 * decision — grant them the admin role — but it is never the accident of a role map.
 */
const PERMITS: Readonly<Record<string, readonly ProcurementAction[]>> = {
  admin: ['read', 'write', 'commit', 'decide', 'configure'],
  buyer: ['read', 'write', 'commit'],
  approver: ['read', 'decide'],
  viewer: ['read'],
}

export class ProcurementAuthGuard implements CanActivate {
  constructor(
    private readonly runtime: ProcurementRuntime,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()]
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true
    const request = context.switchToHttp().getRequest<ProcurementRequest>()
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
    const action = this.reflector.getAllAndOverride<ProcurementAction>(ACTION, targets)
    if (!action) return true
    const allowed = principal.roles.some(
      (assignment) =>
        assignment.module === 'procurement' &&
        (PERMITS[assignment.role]?.includes(action) ?? false),
    )
    if (!allowed)
      throw new ForbiddenException('The Procurement role does not permit this operation')
    return true
  }
}
