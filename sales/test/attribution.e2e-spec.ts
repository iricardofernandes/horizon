import { randomBytes, randomUUID } from 'node:crypto'
import type { EventEnvelope } from '@horizon/contracts'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SalesModuleEventHandlers } from '@/application/consume-module-events'
import {
  DecideQuoteUseCase,
  ReviseQuoteUseCase,
  WriteQuoteUseCase,
} from '@/application/use-cases/manage-quotes'
import type { Either } from '@/core/either'
import { AesGcmSecretBox } from '@/infrastructure/cryptography/aes-gcm-secret-box'
import { SalesDatabase } from '@/infrastructure/database/drizzle/sales-database'

/**
 * Phase 58 on PostgreSQL: the opportunity projection converges whatever order its facts
 * arrive in, a quote freezes the attribution it read there on every version and event,
 * and the projection is tenant-scoped.
 */
const clock = { now: () => new Date() }
let database: SalesDatabase
let administrator: ReturnType<typeof postgres>
let application: ReturnType<typeof postgres>
let handlers: SalesModuleEventHandlers['handlers']

beforeAll(() => {
  database = new SalesDatabase({
    url: process.env.DATABASE_URL ?? '',
    customerPrivacy: { secretBox: new AesGcmSecretBox(), blindIndexKey: randomBytes(32) },
  })
  handlers = new SalesModuleEventHandlers(database, clock).handlers
  administrator = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
  application = postgres(process.env.DATABASE_URL ?? '', { max: 1 })
})

afterAll(async () => {
  await Promise.allSettled([database?.close(), administrator?.end(), application?.end()])
})

function valid<L, R>(result: Either<L, R>): R {
  if (result.isLeft()) throw result.value
  return result.value
}

const commandOf = (tenantId: string) => ({
  tenantId,
  actor: 'ana',
  requestId: null,
  idempotencyKey: randomUUID(),
})

async function deliver(
  tenantId: string,
  eventType: string,
  payload: object,
  occurredAt = new Date(),
) {
  const handler = handlers[eventType]
  if (!handler) throw new Error(`Sales does not consume ${eventType}`)
  const event: EventEnvelope = {
    eventId: randomUUID(),
    eventType,
    eventVersion: eventType.startsWith('parties.') ? 2 : 1,
    occurredAt: occurredAt.toISOString(),
    tenantId,
    traceId: randomBytes(16).toString('hex'),
    payload,
  }
  await handler(event)
  return event
}

/** A customer projected from Parties, a priced item and an open opportunity in CRM. */
async function world() {
  const tenantId = randomUUID()
  const customerId = randomUUID()
  await deliver(tenantId, 'parties.party.registered', {
    partyId: customerId,
    kind: 'organization',
    legalName: 'Initech Ltda',
    tradeName: null,
    email: 'compras@initech.example',
    phone: '+5511999990000',
    address: 'Rua Um, 42',
    documentType: 'none',
    documentCountry: null,
    roles: ['customer'],
  })
  const itemId = randomUUID()
  await administrator`insert into catalog_items
    (tenant_id, item_id, description, unit_price, currency, active, updated_at)
    values (${tenantId}, ${itemId}, 'Licença', 100000, 'BRL', 1, now())`
  const opportunityId = randomUUID()
  const ownerId = randomUUID()
  const sourceId = randomUUID()
  await deliver(tenantId, 'crm.opportunity.created', {
    opportunityId,
    accountId: customerId,
    pipelineId: randomUUID(),
    stageId: randomUUID(),
    probabilityBps: 2500,
    ownerId,
    sourceId,
    expectedValue: { amount: '100000', currency: 'BRL' },
    expectedCloseOn: '2026-12-01',
  })
  return { tenantId, customerId, itemId, opportunityId, ownerId, sourceId }
}

describe('quote attribution on PostgreSQL', () => {
  it('freezes the owner and source on every version and on every quote event', async () => {
    const w = await world()
    const write = new WriteQuoteUseCase(database, clock, 15)
    const { quoteId } = valid(
      await write.execute({
        context: commandOf(w.tenantId),
        customerId: w.customerId,
        opportunityId: w.opportunityId,
        quote: { lines: [{ lineId: randomUUID(), itemId: w.itemId, quantity: '1' }] },
      }),
    )
    const decide = new DecideQuoteUseCase(database, clock)
    valid(await decide.send(commandOf(w.tenantId), quoteId))
    await deliver(w.tenantId, 'crm.opportunity.owner-changed', {
      opportunityId: w.opportunityId,
      accountId: w.customerId,
      fromOwnerId: w.ownerId,
      toOwnerId: randomUUID(),
    })
    const next = valid(
      await new ReviseQuoteUseCase(database, clock, 15).execute({
        context: commandOf(w.tenantId),
        quoteId,
        quote: { lines: [{ lineId: randomUUID(), itemId: w.itemId, quantity: '3' }] },
      }),
    )
    valid(await decide.send(commandOf(w.tenantId), next.quoteId))
    valid(await decide.accept(commandOf(w.tenantId), next.quoteId))

    const attribution = { opportunityId: w.opportunityId, ownerId: w.ownerId, sourceId: w.sourceId }
    expect((await database.findQuoteSnapshot(w.tenantId, quoteId))?.attribution).toEqual(
      attribution,
    )
    expect((await database.findQuoteSnapshot(w.tenantId, next.quoteId))?.attribution).toEqual(
      attribution,
    )
    const events = await administrator<{ event_type: string; payload: { attribution: unknown } }[]>`
      select event_type, payload from outbox
      where tenant_id = ${w.tenantId} and event_type like 'sales.quote.%' order by occurred_at, event_type`
    expect(events.map((row) => row.event_type)).toEqual([
      'sales.quote.sent',
      'sales.quote.sent',
      'sales.quote.accepted',
    ])
    for (const row of events) expect(row.payload.attribution).toEqual(attribution)
    await expect(
      administrator`update quotes set opportunity_id = ${w.opportunityId}, attributed_owner_id = null where id = ${quoteId}`,
    ).rejects.toThrow(/quotes_attribution/)
  })

  it('converges the projection whatever order the facts arrive in, and scopes it to the tenant', async () => {
    const w = await world()
    const closedAt = new Date(Date.now() + 60_000)
    await deliver(
      w.tenantId,
      'crm.opportunity.won',
      {
        opportunityId: w.opportunityId,
        accountId: w.customerId,
        pipelineId: randomUUID(),
        stageId: randomUUID(),
        ownerId: w.ownerId,
        sourceId: null,
        value: { amount: '100000', currency: 'BRL' },
        closedOn: closedAt.toISOString().slice(0, 10),
      },
      closedAt,
    )
    // A late redelivery of an older fact does not reopen what was won.
    await deliver(
      w.tenantId,
      'crm.opportunity.reopened',
      {
        opportunityId: w.opportunityId,
        accountId: w.customerId,
        pipelineId: randomUUID(),
        stageId: randomUUID(),
        probabilityBps: 1000,
        previousStatus: 'lost',
      },
      new Date(closedAt.getTime() - 30_000),
    )
    const [row] = await administrator`select status, source_id from opportunity_projections
      where tenant_id = ${w.tenantId} and id = ${w.opportunityId}`
    expect(row).toEqual({ status: 'won', source_id: null })
    const refused = await new WriteQuoteUseCase(database, clock, 15).execute({
      context: commandOf(w.tenantId),
      customerId: w.customerId,
      opportunityId: w.opportunityId,
      quote: { lines: [{ lineId: randomUUID(), itemId: w.itemId, quantity: '1' }] },
    })
    expect(refused.isLeft() && refused.value.message).toMatch(/is won/)

    const intruder = randomUUID()
    const visible = await application.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${intruder}, true)`
      return tx`select count(*)::int as n from opportunity_projections`
    })
    expect(visible[0]?.n).toBe(0)
  })
})
