import { SCOPE_REFUSAL_MESSAGE, scopeAllows } from '@horizon/contracts'
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common'
import type { Reflector } from '@nestjs/core'
import { DELEGABLE_PERMISSIONS } from '@/domain/controls/duties'
import type { AccessClaims } from '@/infrastructure/cryptography/access-token-verifier'
import type { InventoryRuntime } from '@/main/inventory-runtime'

const PUBLIC = 'inventory:public'
const ACTION = 'inventory:action'
export const PublicRoute = () => SetMetadata(PUBLIC, true)
export type InventoryAction = 'read' | 'manage' | 'approve' | 'import' | 'audit'
export const RequireInventoryAction = (action: InventoryAction) => SetMetadata(ACTION, action)

export interface InventoryRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  principal?: AccessClaims
}

export function tenantOf(request: InventoryRequest): string {
  if (!request.principal) throw new UnauthorizedException()
  return request.principal.tenantId
}

export function actorOf(request: InventoryRequest): string {
  if (!request.principal) throw new UnauthorizedException()
  return request.principal.subject
}

/**
 * An operator moves stock; allowing a write-off, loading opening balances in bulk (Phase 64)
 * and reading the audit log (Phase 68) take an admin. An admin can do both, which is
 * deliberate — the four-eyes rule is about who a person is, not what they may do, and it is
 * the aggregate and the table that refuse one's own approval (ADR 0062).
 */
function permits(principal: AccessClaims | undefined, action: InventoryAction): boolean {
  return (
    principal?.roles.some(
      (assignment) =>
        assignment.module === 'inventory' &&
        (assignment.role === 'admin' ||
          (action === 'read' && ['operator', 'viewer'].includes(assignment.role)) ||
          (action === 'manage' && assignment.role === 'operator') ||
          (action === 'audit' && assignment.role === 'auditor')),
    ) ?? false
  )
}

/** The approvals the person holds through an Inventory role (ADR 0062). */
export function approvalsOf(request: InventoryRequest): readonly string[] {
  return permits(request.principal, 'approve') ? DELEGABLE_PERMISSIONS : []
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
    // A key's scopes before any role (ADR 0064), so a read-only key reads the same everywhere.
    const method = context.switchToHttp().getRequest<{ method?: string }>().method ?? 'POST'
    if (!scopeAllows(request.principal.scopes, 'inventory', method))
      throw new ForbiddenException(SCOPE_REFUSAL_MESSAGE)
    const action = this.reflector.getAllAndOverride<InventoryAction>(ACTION, targets)
    if (!action) return true
    if (!permits(request.principal, action))
      throw new ForbiddenException('The Inventory role does not permit this operation')
    return true
  }
}
