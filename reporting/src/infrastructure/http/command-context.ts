import { BadRequestException } from '@nestjs/common'
import type { CommandContext, IdempotentContext } from '@/application/use-cases/commands'
import { actorOf, type ReportingRequest, tenantOf } from './authorization'

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,255}$/

export function commandContext(request: ReportingRequest): CommandContext {
  const requestId = request.headers['x-request-id']
  return {
    tenantId: tenantOf(request),
    actor: actorOf(request),
    requestId: typeof requestId === 'string' ? requestId.slice(0, 128) : null,
  }
}

/** Commands that create a record require a key, so a retry never creates two (ADR 0028). */
export function idempotentContext(request: ReportingRequest): IdempotentContext {
  const key = request.headers['idempotency-key']
  if (typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key))
    throw new BadRequestException(
      'Idempotency-Key header is required: 8 to 255 visible ASCII characters',
    )
  return { ...commandContext(request), idempotencyKey: key }
}
