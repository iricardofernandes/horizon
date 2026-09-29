import { SCOPE_REFUSAL_MESSAGE, scopeAllows } from '@horizon/contracts'
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

const PUBLIC = 'agent:public'
/** The MCP endpoint authenticates the API key itself (ADR 0065); health is open. */
export const PublicRoute = () => SetMetadata(PUBLIC, true)

export interface AgentRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  readonly method?: string
  principal?: AccessClaims
}

export function principalOf(request: AgentRequest): AccessClaims {
  if (!request.principal) throw new UnauthorizedException()
  return request.principal
}

/**
 * `agent` holds no roles (ADR 0065): its switch and its log belong to the workspace's
 * administrators, as Identity names them; an auditor may read the log.
 */
export function requireWorkspaceRole(
  request: AgentRequest,
  roles: readonly ('owner' | 'admin' | 'auditor')[],
): void {
  const held = principalOf(request).roles
  if (!held.some((role) => role.module === 'identity' && (roles as string[]).includes(role.role)))
    throw new ForbiddenException(`This takes the Identity ${roles.join(' or ')} role`)
}

/** Verifies a person's token on every route but the MCP endpoint and health (ADR 0008). */
export class AgentAuthGuard implements CanActivate {
  constructor(
    private readonly accessTokens: AccessTokenVerifier,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()]
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true
    const request = context.switchToHttp().getRequest<AgentRequest>()
    const authorization = request.headers.authorization
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer '))
      throw new UnauthorizedException()
    try {
      request.principal = await this.accessTokens.verify(authorization.slice(7))
    } catch {
      throw new UnauthorizedException()
    }
    // A key token names no `agent:read` or `agent:write`, so it never reaches the switch
    // or the log: only a person does (ADR 0064).
    if (!scopeAllows(request.principal.scopes, 'agent', request.method ?? 'POST'))
      throw new ForbiddenException(SCOPE_REFUSAL_MESSAGE)
    return true
  }
}
