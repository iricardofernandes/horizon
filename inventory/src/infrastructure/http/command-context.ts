import { BadRequestException } from '@nestjs/common'
import { z } from 'zod'
import type { CommandContext, IdempotentContext } from '@/application/use-cases/commands'
import { actorOf, type InventoryRequest, tenantOf } from './authorization'
import { parse } from './request-parsing'

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,255}$/
const MAX_PAGE = 200
const MAX_RANGE_DAYS = 366

export const businessDate = z.iso.date()

const today = () => new Date().toISOString().slice(0, 10)

function daysBefore(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() - days)
  return value.toISOString().slice(0, 10)
}

/**
 * A bounded range of days, given back as the instants that bound it.
 *
 * Stock moves at an instant rather than on a date, so a report asked about days has to
 * decide what a day is. It is the UTC one, as everywhere else in the repository, and the
 * closing instant is the last millisecond of the closing day — so a range ending today
 * includes everything that has happened today, and asking twice in the same afternoon
 * gives the same answer about yesterday.
 */
export function rangeOf(query: unknown): { from: string; to: string } {
  const input = parse(
    z.object({ from: businessDate.optional(), to: businessDate.optional() }),
    query,
  )
  const to = input.to ?? today()
  const from = input.from ?? daysBefore(to, 30)
  if (from > to) throw new BadRequestException('from: must not be after to')
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_RANGE_DAYS)
    throw new BadRequestException(`the range may span at most ${MAX_RANGE_DAYS} days`)
  return { from: `${from}T00:00:00.000Z`, to: `${to}T23:59:59.999Z` }
}

/**
 * The instant a valuation is asked about; the default is now, not the end of today.
 *
 * "As of today" has to mean "as things stand", because a valuation that quietly includes
 * the rest of the afternoon would disagree with the shelf anybody went and looked at.
 */
export function asOfInstantOf(query: unknown): string {
  const input = parse(z.object({ asOf: businessDate.optional() }), query)
  if (!input.asOf) return new Date().toISOString()
  if (input.asOf >= today()) return new Date().toISOString()
  return `${input.asOf}T23:59:59.999Z`
}

export const pageOf = (query: unknown): { limit: number; offset: number } =>
  parse(
    z.object({
      limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }),
    query,
  )

export function context(request: InventoryRequest): CommandContext {
  const requestId = request.headers['x-request-id']
  return {
    tenantId: tenantOf(request),
    actor: actorOf(request),
    requestId: typeof requestId === 'string' ? requestId.slice(0, 128) : null,
  }
}

/**
 * Commands that move stock require a key, so a retried request never moves it twice
 * (ADR 0028). A decision on a document that already exists does not: repeating it is
 * refused by the document's own state, which is a better answer than a stored receipt.
 */
export function idempotent(request: InventoryRequest): IdempotentContext {
  const key = request.headers['idempotency-key']
  if (typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key))
    throw new BadRequestException(
      'Idempotency-Key header is required: 8 to 255 visible ASCII characters',
    )
  return { ...context(request), idempotencyKey: key }
}
