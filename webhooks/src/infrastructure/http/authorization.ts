import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common'
import type { Reflector } from '@nestjs/core'
import type { AccessClaims } from '@/infrastructure/cryptography/access-token-verifier'
import type { WebhookRuntime } from '@/main/webhook-runtime'

const PUBLIC = 'webhooks:public'
const ACTION = 'webhooks:action'
export const PublicRoute = () => SetMetadata(PUBLIC, true)
export const RequireWebhookAction = (action: 'read' | 'manage') => SetMetadata(ACTION, action)

export interface WebhookRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  principal?: AccessClaims
}

export function tenantOf(request: WebhookRequest): string {
  if (!request.principal) throw new UnauthorizedException()
  return request.principal.tenantId
}

export class WebhookAuthGuard implements CanActivate {
  constructor(
    private readonly runtime: WebhookRuntime,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()]
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true
    const request = context.switchToHttp().getRequest<WebhookRequest>()
    const authorization = request.headers.authorization
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer '))
      throw new UnauthorizedException()
    try {
      request.principal = await this.runtime.accessTokens.verify(authorization.slice(7))
    } catch {
      throw new UnauthorizedException()
    }
    const action = this.reflector.getAllAndOverride<'read' | 'manage'>(ACTION, targets)
    if (!action) return true
    const roles = request.principal.roles.filter((role) => role.module === 'webhooks')
    const allowed = roles.some(
      (role) => role.role === 'admin' || (action === 'read' && role.role === 'viewer'),
    )
    if (!allowed) throw new ForbiddenException('The Webhooks role does not permit this operation')
    return true
  }
}
