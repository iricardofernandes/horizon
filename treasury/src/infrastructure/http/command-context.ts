import { BadRequestException } from '@nestjs/common'
import { z } from 'zod'
import type { CommandContext, IdempotentContext } from '@/application/use-cases/commands'
import { actorOf, type TreasuryRequest, tenantOf } from './authorization'
import { parse } from './request-parsing'

const MAX_RANGE_DAYS = 366
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,255}$/
export const businessDate = z.iso.date()

export function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function daysBefore(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() - days)
  return value.toISOString().slice(0, 10)
}

/** A bounded value-date range; the default is the last thirty days up to today. */
export function rangeOf(query: unknown): { from: string; to: string } {
  const input = parse(
    z.object({ from: businessDate.optional(), to: businessDate.optional() }),
    query,
  )
  const to = input.to ?? today()
  const from = input.from ?? daysBefore(to, 30)
  if (from > to) throw new BadRequestException('from: must not be after to')
  const span = (Date.parse(to) - Date.parse(from)) / 86_400_000
  if (span > MAX_RANGE_DAYS)
    throw new BadRequestException(`the range may span at most ${MAX_RANGE_DAYS} days`)
  return { from, to }
}

export function context(request: TreasuryRequest): CommandContext {
  const requestId = request.headers['x-request-id']
  return {
    tenantId: tenantOf(request),
    actor: actorOf(request),
    requestId: typeof requestId === 'string' ? requestId.slice(0, 128) : null,
  }
}

/** Money-moving commands require a key, so a retried request never moves money twice (ADR 0028). */
export function idempotent(request: TreasuryRequest): IdempotentContext {
  const key = request.headers['idempotency-key']
  if (typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key))
    throw new BadRequestException(
      'Idempotency-Key header is required: 8 to 255 visible ASCII characters',
    )
  return { ...context(request), idempotencyKey: key }
}
