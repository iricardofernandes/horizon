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
import type { CrmRuntime } from '@/main/crm-runtime'

const PUBLIC = 'crm:public'
const ACTION = 'crm:action'
export type CrmAction = 'read' | 'write' | 'assign' | 'erase' | 'configure'
export const PublicRoute = () => SetMetadata(PUBLIC, true)
export const RequireCrmAction = (action: CrmAction) => SetMetadata(ACTION, action)

export interface CrmRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  principal?: AccessClaims
}

export function actorOf(request: CrmRequest): string {
  if (!request.principal) throw new UnauthorizedException()
  return request.principal.subject
}

export function tenantOf(request: CrmRequest): string {
  if (!request.principal) throw new UnauthorizedException()
  return request.principal.tenantId
}

/**
 * The static role map for this module (ADR 0023).
 *
 * A representative works the accounts and opportunities; deciding who looks after them, and
 * how pipelines and lists are set up, is a manager's call; destroying a person's data is
 * an administrator's. Visibility is tenant-wide: roles
 * are module-scoped, so there is no "only my accounts" here (CRM plan, out of scope).
 */
export const PERMITS: Readonly<Record<string, readonly CrmAction[]>> = {
  admin: ['read', 'write', 'assign', 'erase', 'configure'],
  manager: ['read', 'write', 'assign', 'configure'],
  representative: ['read', 'write'],
  viewer: ['read'],
}

/** Whether any of the caller's CRM roles grants the action. */
export function permits(
  roles: readonly { readonly module: string; readonly role: string }[],
  action: CrmAction,
): boolean {
  return roles.some(
    (assignment) =>
      assignment.module === 'crm' && (PERMITS[assignment.role]?.includes(action) ?? false),
  )
}

export class CrmAuthGuard implements CanActivate {
  constructor(
    private readonly runtime: CrmRuntime,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()]
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true
    const request = context.switchToHttp().getRequest<CrmRequest>()
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
    // A key's scopes before any role (ADR 0064), so a read-only key reads the same everywhere.
    const method = context.switchToHttp().getRequest<{ method?: string }>().method ?? 'POST'
    if (!scopeAllows(principal.scopes, 'crm', method))
      throw new ForbiddenException(SCOPE_REFUSAL_MESSAGE)
    const action = this.reflector.getAllAndOverride<CrmAction>(ACTION, targets)
    if (!action) return true
    if (!permits(principal.roles, action))
      throw new ForbiddenException('The CRM role does not permit this operation')
    return true
  }
}
