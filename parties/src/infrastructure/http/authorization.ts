import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common'
import type { Reflector } from '@nestjs/core'
import type { AccessClaims } from '@/infrastructure/cryptography/access-token-verifier'
import type { PartiesRuntime } from '@/main/parties-runtime'

const PUBLIC = 'parties:public'
const ACTION = 'parties:action'
export const PublicRoute = () => SetMetadata(PUBLIC, true)
export const RequirePartiesAction = (action: 'read' | 'manage' | 'erase') =>
  SetMetadata(ACTION, action)

export interface PartiesRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  principal?: AccessClaims
}

export function tenantOf(request: PartiesRequest): string {
  if (!request.principal) throw new UnauthorizedException()
  return request.principal.tenantId
}

/**
 * The static role map for this module (ADR 0023). Erasure is admin-only: it is
 * irreversible and reaches every context that projects the party.
 */
const PERMITS: Readonly<Record<string, readonly ('read' | 'manage' | 'erase')[]>> = {
  admin: ['read', 'manage', 'erase'],
  editor: ['read', 'manage'],
  viewer: ['read'],
}

/**
 * Sales representatives register and read customers today. Until every existing
 * workspace has been granted a `parties` role, a Sales role keeps that ability here, for
 * reading and managing only — never erasing.
 */
const SALES_BRIDGE: Readonly<Record<string, readonly ('read' | 'manage')[]>> = {
  admin: ['read', 'manage'],
  representative: ['read', 'manage'],
  viewer: ['read'],
}

export class PartiesAuthGuard implements CanActivate {
  constructor(
    private readonly runtime: PartiesRuntime,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()]
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true
    const request = context.switchToHttp().getRequest<PartiesRequest>()
    const authorization = request.headers.authorization
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer '))
      throw new UnauthorizedException()
    try {
      request.principal = await this.runtime.accessTokens.verify(authorization.slice(7))
    } catch {
      throw new UnauthorizedException()
    }
    const action = this.reflector.getAllAndOverride<'read' | 'manage' | 'erase'>(ACTION, targets)
    if (!action) return true
    const allowed = request.principal.roles.some((assignment) => {
      if (assignment.module === 'parties')
        return PERMITS[assignment.role]?.includes(action) ?? false
      if (assignment.module === 'sales' && action !== 'erase')
        return SALES_BRIDGE[assignment.role]?.includes(action) ?? false
      return false
    })
    if (!allowed) throw new ForbiddenException('The assigned role does not permit this operation')
    return true
  }
}
