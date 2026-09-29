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

const PUBLIC = 'knowledge:public'
/** Health is open; everything else takes a verified token (ADR 0008). */
export const PublicRoute = () => SetMetadata(PUBLIC, true)

export interface KnowledgeRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  readonly method?: string
  principal?: AccessClaims
}

export function principalOf(request: KnowledgeRequest): AccessClaims {
  if (!request.principal) throw new UnauthorizedException()
  return request.principal
}

/**
 * `knowledge` holds no roles (ADR 0067): its status belongs to the workspace's
 * administrators, as Identity names them; an auditor may read it.
 */
export function requireWorkspaceRole(
  request: KnowledgeRequest,
  roles: readonly ('owner' | 'admin' | 'auditor')[],
): void {
  const held = principalOf(request).roles
  if (!held.some((role) => role.module === 'identity' && (roles as string[]).includes(role.role)))
    throw new ForbiddenException(`This takes the Identity ${roles.join(' or ')} role`)
}

/** Verifies the token of every route but health (ADR 0008). */
export class KnowledgeAuthGuard implements CanActivate {
  constructor(
    private readonly accessTokens: AccessTokenVerifier,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()]
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true
    const request = context.switchToHttp().getRequest<KnowledgeRequest>()
    const authorization = request.headers.authorization
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer '))
      throw new UnauthorizedException()
    try {
      request.principal = await this.accessTokens.verify(authorization.slice(7))
    } catch {
      throw new UnauthorizedException()
    }
    // A key reaches the index only with `knowledge:read`, and writes nothing (ADR 0064).
    if (!scopeAllows(request.principal.scopes, 'knowledge', request.method ?? 'POST'))
      throw new ForbiddenException(SCOPE_REFUSAL_MESSAGE)
    return true
  }
}
