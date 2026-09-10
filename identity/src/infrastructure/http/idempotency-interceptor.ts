import {
  BadRequestException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
  SetMetadata,
} from '@nestjs/common'
import type { Reflector } from '@nestjs/core'
import { defer, lastValueFrom, type Observable } from 'rxjs'
import { z } from 'zod'

import type { IdentityHttpRequest } from './http-context'
import type { IdempotencyStore } from './idempotency-store'

const SKIP_IDEMPOTENCY = 'identity:skip-idempotency'
const SIGNUP_IDEMPOTENCY = 'identity:signup-idempotency'

/** Credential exchanges must always evaluate current session and revocation state. */
export const SkipIdempotency = () => SetMetadata(SKIP_IDEMPOTENCY, true)
export const IdempotencySignup = () => SetMetadata(SIGNUP_IDEMPOTENCY, true)

const signupIdentity = z.object({
  slug: z.string().min(1),
  owner: z.object({ email: z.string().min(1), password: z.string().min(1) }),
})

interface IdempotencyHttpResponse {
  statusCode: number
  status(code: number): unknown
}

export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly store: IdempotencyStore,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<IdentityHttpRequest & { body?: unknown }>()
    const key = request.headers['idempotency-key']
    const targets = [context.getHandler(), context.getClass()]
    if (
      key === undefined ||
      !['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) ||
      this.reflector.getAllAndOverride<boolean>(SKIP_IDEMPOTENCY, targets)
    )
      return next.handle()
    if (typeof key !== 'string' || key.length === 0 || key.length > 255)
      throw new BadRequestException(
        'Idempotency-Key must be one nonempty value of at most 255 characters',
      )

    const scope = this.scopeFor(request, context)
    const response = context.switchToHttp().getResponse<IdempotencyHttpResponse>()
    return defer(async () => {
      const claim = await this.store.begin({
        ...scope,
        endpoint: `${request.method} ${request.originalUrl ?? request.url}`,
        key,
        body: request.body,
      })
      if (claim.state === 'replay') {
        response.status(claim.response.statusCode)
        return claim.response.body
      }

      let body: unknown
      try {
        body = await lastValueFrom(next.handle())
      } catch (error) {
        await this.store.release(claim)
        throw error
      }
      // Completion failures retain the pending claim, because the domain may have
      // committed already. Releasing here would permit a duplicate write.
      await this.store.complete(claim, { statusCode: response.statusCode, body })
      return body
    })
  }

  private scopeFor(
    request: IdentityHttpRequest & { body?: unknown },
    context: ExecutionContext,
  ): { tenantId: string; principal: string } {
    if (request.principal)
      return { tenantId: request.principal.tenantId, principal: request.principal.subject }
    if (
      !this.reflector.getAllAndOverride<boolean>(SIGNUP_IDEMPOTENCY, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      throw new BadRequestException('Idempotency requires an authenticated principal')
    const identity = signupIdentity.parse(request.body)
    return {
      tenantId: `signup:${identity.slug.trim().toLowerCase()}`,
      principal: this.store.principalFingerprint({
        email: identity.owner.email.trim().toLowerCase(),
        password: identity.owner.password,
      }),
    }
  }
}
