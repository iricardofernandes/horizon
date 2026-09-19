import { BadRequestException } from '@nestjs/common'
import type { CommandContext, IdempotentContext } from '@/application/use-cases/commands'
import { actorOf, type SalesRequest, tenantOf } from './authorization'

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,255}$/

export function context(request: SalesRequest): CommandContext {
  const requestId = request.headers['x-request-id']
  return {
    tenantId: tenantOf(request),
    actor: actorOf(request),
    requestId: typeof requestId === 'string' ? requestId.slice(0, 128) : null,
  }
}

/**
 * Commands that create a document require a key, so a retried request never writes two
 * (ADR 0028). A decision on a document that already exists does not: repeating it is
 * refused by the document's own state, which is a better answer than a stored receipt.
 */
export function idempotent(request: SalesRequest): IdempotentContext {
  const key = request.headers['idempotency-key']
  if (typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key))
    throw new BadRequestException(
      'Idempotency-Key header is required: 8 to 255 visible ASCII characters',
    )
  return { ...context(request), idempotencyKey: key }
}
