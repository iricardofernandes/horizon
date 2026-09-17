import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common'
import type { Reflector } from '@nestjs/core'
import type { AccessClaims } from '@/infrastructure/cryptography/access-token-verifier'
import type { LedgerRuntime } from '@/main/ledger-runtime'

const PUBLIC = 'ledger:public'
const ACTION = 'ledger:action'
export type LedgerAction = 'read' | 'configure' | 'post' | 'reverse' | 'close'
export const PublicRoute = () => SetMetadata(PUBLIC, true)
export const RequireLedgerAction = (action: LedgerAction) => SetMetadata(ACTION, action)

export interface LedgerRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  principal?: AccessClaims
}

export function actorOf(request: LedgerRequest): string {
  if (!request.principal) throw new UnauthorizedException()
  return request.principal.subject
}

export function tenantOf(request: LedgerRequest): string {
  if (!request.principal) throw new UnauthorizedException()
  return request.principal.tenantId
}

/**
 * The static role map for this module (ADR 0023). The chart of accounts decides what every
 * report can ever say, so changing it is admin-only. An accountant posts and reverses —
 * a reversal is ordinary accounting work, not an escalation, because it never destroys the
 * original (ADR 0042). Closing a month freezes what everyone else may post, so it stays
 * with admins.
 */
const PERMITS: Readonly<Record<string, readonly LedgerAction[]>> = {
  admin: ['read', 'configure', 'post', 'reverse', 'close'],
  accountant: ['read', 'post', 'reverse'],
  viewer: ['read'],
}

export class LedgerAuthGuard implements CanActivate {
  constructor(
    private readonly runtime: LedgerRuntime,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()]
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true
    const request = context.switchToHttp().getRequest<LedgerRequest>()
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
    const action = this.reflector.getAllAndOverride<LedgerAction>(ACTION, targets)
    if (!action) return true
    const allowed = principal.roles.some(
      (assignment) =>
        assignment.module === 'ledger' && (PERMITS[assignment.role]?.includes(action) ?? false),
    )
    if (!allowed) throw new ForbiddenException('The Ledger role does not permit this operation')
    return true
  }
}
