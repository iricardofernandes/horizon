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
import type { ProcurementRuntime } from '@/main/procurement-runtime'

const PUBLIC = 'procurement:public'
const ACTION = 'procurement:action'
export type ProcurementAction = 'read' | 'write' | 'commit' | 'decide' | 'configure' | 'audit'
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
 * decision — grant them the admin role — but it is never the accident of a role map. Even
 * then the aggregate refuses whoever did the work (ADR 0062). A decision can be lent to any
 * member of the module for a period, so the decide routes admit every role and the use case
 * judges; reading the audit log is an admin's (Phase 68).
 */
const PERMITS: Readonly<Record<string, readonly ProcurementAction[]>> = {
  admin: ['read', 'write', 'commit', 'decide', 'configure', 'audit'],
  buyer: ['read', 'write', 'commit'],
  approver: ['read', 'decide'],
  viewer: ['read'],
  auditor: ['audit'],
}

function permits(principal: AccessClaims | undefined, action: ProcurementAction): boolean {
  return (
    principal?.roles.some(
      (assignment) =>
        assignment.module === 'procurement' &&
        (PERMITS[assignment.role]?.includes(action) ?? false),
    ) ?? false
  )
}

/** The approvals the person holds through a Procurement role (ADR 0062). */
export function approvalsOf(request: ProcurementRequest): readonly string[] {
  return permits(request.principal, 'decide') ? DELEGABLE_PERMISSIONS : []
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
    // A key's scopes before any role (ADR 0064), so a read-only key reads the same everywhere.
    const method = context.switchToHttp().getRequest<{ method?: string }>().method ?? 'POST'
    if (!scopeAllows(principal.scopes, 'procurement', method))
      throw new ForbiddenException(SCOPE_REFUSAL_MESSAGE)
    const action = this.reflector.getAllAndOverride<ProcurementAction>(ACTION, targets)
    if (!action) return true
    if (!permits(principal, action))
      throw new ForbiddenException('The Procurement role does not permit this operation')
    return true
  }
}
