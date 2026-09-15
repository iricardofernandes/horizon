import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common'
import type { Reflector } from '@nestjs/core'
import type { AccessClaims } from '@/infrastructure/cryptography/access-token-verifier'
import type { InventoryRuntime } from '@/main/inventory-runtime'

const PUBLIC = 'inventory:public'
const ACTION = 'inventory:action'
export const PublicRoute = () => SetMetadata(PUBLIC, true)
export const RequireInventoryAction = (action: 'read' | 'manage') => SetMetadata(ACTION, action)

export interface InventoryRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  principal?: AccessClaims
}

export function tenantOf(request: InventoryRequest): string {
  if (!request.principal) throw new UnauthorizedException()
  return request.principal.tenantId
}

export class InventoryAuthGuard implements CanActivate {
  constructor(
    private readonly runtime: InventoryRuntime,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()]
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true
    const request = context.switchToHttp().getRequest<InventoryRequest>()
    const authorization = request.headers.authorization
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer '))
      throw new UnauthorizedException()
    try {
      request.principal = await this.runtime.accessTokens.verify(authorization.slice(7))
    } catch {
      throw new UnauthorizedException()
    }
    const action = this.reflector.getAllAndOverride<'read' | 'manage'>(ACTION, targets)
    if (!action) return true
    const allowed = request.principal.roles.some(
      (assignment) =>
        assignment.module === 'inventory' &&
        (assignment.role === 'admin' ||
          (action === 'read' && ['operator', 'viewer'].includes(assignment.role)) ||
          (action === 'manage' && assignment.role === 'operator')),
    )
    if (!allowed) throw new ForbiddenException('The Inventory role does not permit this operation')
    return true
  }
}
