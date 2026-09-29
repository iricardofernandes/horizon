import { SCOPE_REFUSAL_MESSAGE, scopeAllows } from '@horizon/contracts'
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common'
import type { Reflector } from '@nestjs/core'
import { type Action, type AttachingModule, permits } from '@/domain/records'
import type {
  AccessClaims,
  AccessTokenVerifier,
} from '@/infrastructure/cryptography/access-token-verifier'

const PUBLIC = 'files:public'
export const PublicRoute = () => SetMetadata(PUBLIC, true)

export interface FilesRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  principal?: AccessClaims
}

export function principalOf(request: FilesRequest): AccessClaims {
  if (!request.principal) throw new UnauthorizedException()
  return request.principal
}

/**
 * `files` holds no roles (ADR 0060): the owning module's role, read from the token, says
 * who reads or attaches. Refused before anything is read when the module is known.
 */
export function requireRole(request: FilesRequest, module: AttachingModule, action: Action): void {
  if (!permits(principalOf(request).roles, module, action))
    throw new ForbiddenException(`A ${module} role that can ${action} this record is required`)
}

/** Verifies the token of every route but the signed-link ones (ADR 0008). */
export class FilesAuthGuard implements CanActivate {
  constructor(
    private readonly accessTokens: AccessTokenVerifier,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()]
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true
    const request = context.switchToHttp().getRequest<FilesRequest>()
    const authorization = request.headers.authorization
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer '))
      throw new UnauthorizedException()
    try {
      request.principal = await this.accessTokens.verify(authorization.slice(7))
    } catch {
      throw new UnauthorizedException()
    }
    // A key's scopes before any role (ADR 0064), so a read-only key reads the same everywhere.
    const method = context.switchToHttp().getRequest<{ method?: string }>().method ?? 'POST'
    if (!scopeAllows(request.principal.scopes, 'files', method))
      throw new ForbiddenException(SCOPE_REFUSAL_MESSAGE)
    return true
  }
}
