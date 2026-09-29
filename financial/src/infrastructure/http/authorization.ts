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
import type { FinancialRuntime } from '@/main/financial-runtime'

const PUBLIC = 'financial:public'
const ACTION = 'financial:action'
export type FinancialAction =
  | 'read'
  | 'configure'
  | 'record'
  | 'reverse'
  | 'approve'
  | 'import'
  | 'audit'
export const PublicRoute = () => SetMetadata(PUBLIC, true)
export const RequireFinancialAction = (action: FinancialAction) => SetMetadata(ACTION, action)

export interface FinancialRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  principal?: AccessClaims
}

/**
 * Who performed the act, for every performer field and duty check: a key's token counts
 * as its issuer (ADR 0066), so nobody approves what their own agent or integration drafted.
 */
export function actorOf(request: FinancialRequest): string {
  if (!request.principal) throw new UnauthorizedException()
  return request.principal.keyIssuer ?? request.principal.subject
}

/** The key an act went through, kept beside the person in the audit entry; null for a person. */
export function viaOf(request: FinancialRequest): string | null {
  if (!request.principal) throw new UnauthorizedException()
  return request.principal.keyIssuer ? request.principal.subject : null
}

export function tenantOf(request: FinancialRequest): string {
  if (!request.principal) throw new UnauthorizedException()
  return request.principal.tenantId
}

/**
 * The static role map for this module (ADR 0023). Configuring the chart of categories,
 * dimensions and terms changes how every later title is classified, so it is admin-only.
 * Operators draft, post and settle titles. Reversing something already posted or settled
 * undoes a fact other contexts acted on, so it stays with admins (ADR 0042), as does
 * approving a payable — and the aggregate refuses an approval by whoever requested it.
 * Loading the open titles of a go-live in bulk is an administrator's work too (Phase 64), and
 * so is reading the audit log (Phase 68). An approval can also be lent to any member of the
 * module for a period: the approve routes admit every role, and the use case decides.
 */
const PERMITS: Readonly<Record<string, readonly FinancialAction[]>> = {
  admin: ['read', 'configure', 'record', 'reverse', 'approve', 'import', 'audit'],
  operator: ['read', 'record'],
  viewer: ['read'],
  auditor: ['audit'],
}

function permits(principal: AccessClaims | undefined, action: FinancialAction): boolean {
  return (
    principal?.roles.some(
      (assignment) =>
        assignment.module === 'financial' && (PERMITS[assignment.role]?.includes(action) ?? false),
    ) ?? false
  )
}

/** The approvals the person holds through a Financial role (ADR 0062). */
export function approvalsOf(request: FinancialRequest): readonly string[] {
  return permits(request.principal, 'approve') ? DELEGABLE_PERMISSIONS : []
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
    // A key's scopes before any role (ADR 0064), so a read-only key reads the same everywhere.
    const method = context.switchToHttp().getRequest<{ method?: string }>().method ?? 'POST'
    if (!scopeAllows(principal.scopes, 'financial', method))
      throw new ForbiddenException(SCOPE_REFUSAL_MESSAGE)
    const action = this.reflector.getAllAndOverride<FinancialAction>(ACTION, targets)
    if (!action) return true
    if (!permits(principal, action))
      throw new ForbiddenException('The Financial role does not permit this operation')
    return true
  }
}
