import {
  BadRequestException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
  SetMetadata,
} from '@nestjs/common'
import type { Reflector } from '@nestjs/core'
import { defer, lastValueFrom, type Observable } from 'rxjs'
import type { CatalogHttpRequest } from './http-context'
import type { IdempotencyStore } from './idempotency-store'

const SKIP_IDEMPOTENCY = 'catalog:skip-idempotency'

/** Catalog has no credential exchange; the escape hatch exists for routes that must
 * re-evaluate live state on every call rather than replay a stored answer. */
export const SkipIdempotency = () => SetMetadata(SKIP_IDEMPOTENCY, true)

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
    const request = context.switchToHttp().getRequest<CatalogHttpRequest & { body?: unknown }>()
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
    if (request.principal === undefined)
      throw new BadRequestException('Idempotency requires an authenticated principal')

    const scope = { tenantId: request.principal.tenantId, principal: request.principal.subject }
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
}
