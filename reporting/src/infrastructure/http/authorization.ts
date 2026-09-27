import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common'
import type { Reflector } from '@nestjs/core'
import type {
  AccessClaims,
  AccessTokenVerifier,
} from '@/infrastructure/cryptography/access-token-verifier'

const PUBLIC = 'reporting:public'
const ACTION = 'reporting:action'
export type ReportingAction =
  | 'read'
  | 'reconcile'
  | 'save'
  | 'share'
  | 'export'
  | 'schedule'
  | 'administer'
export const PublicRoute = () => SetMetadata(PUBLIC, true)
export const RequireReportingAction = (action: ReportingAction) => SetMetadata(ACTION, action)

export interface ReportingRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  principal?: AccessClaims
}

export function actorOf(request: ReportingRequest): string {
  if (!request.principal) throw new UnauthorizedException()
  return request.principal.subject
}

export function tenantOf(request: ReportingRequest): string {
  if (!request.principal) throw new UnauthorizedException()
  return request.principal.tenantId
}

/**
 * The static role map for this module (ADR 0023). Everyone reads and exports what they
 * read; an analyst also reconciles, saves filters and schedules exports; only an
 * administrator shares a filter or sees everyone's exports and schedules.
 */
export const PERMITS: Readonly<Record<string, readonly ReportingAction[]>> = {
  admin: ['read', 'reconcile', 'save', 'share', 'export', 'schedule', 'administer'],
  analyst: ['read', 'reconcile', 'save', 'export', 'schedule'],
  viewer: ['read', 'export'],
}

export function permits(
  roles: readonly { readonly module: string; readonly role: string }[],
  action: ReportingAction,
): boolean {
  return roles.some(
    (assignment) =>
      assignment.module === 'reporting' && (PERMITS[assignment.role]?.includes(action) ?? false),
  )
}

export class ReportingAuthGuard implements CanActivate {
  constructor(
    private readonly accessTokens: AccessTokenVerifier,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()]
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true
    const request = context.switchToHttp().getRequest<ReportingRequest>()
    const authorization = request.headers.authorization
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer '))
      throw new UnauthorizedException()
    let principal: AccessClaims
    try {
      principal = await this.accessTokens.verify(authorization.slice(7))
    } catch {
      throw new UnauthorizedException()
    }
    request.principal = principal
    const action = this.reflector.getAllAndOverride<ReportingAction>(ACTION, targets)
    if (!action) return true
    if (!permits(principal.roles, action))
      throw new ForbiddenException('The reporting role does not permit this operation')
    return true
  }
}
