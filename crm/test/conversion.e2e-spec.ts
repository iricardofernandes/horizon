import { randomBytes, randomUUID } from 'node:crypto'
import type { EventEnvelope } from '@horizon/contracts'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CrmModuleEventHandlers } from '@/application/consume-module-events'
import {
  ChangeOpportunityUseCase,
  CreateOpportunityUseCase,
} from '@/application/use-cases/manage-opportunities'
import { CreatePipelineUseCase } from '@/application/use-cases/manage-pipelines'
import type { Either } from '@/core/either'
import { foldHistory } from '@/domain/entities/opportunity'
import { AesGcmSecretBox } from '@/infrastructure/cryptography/aes-gcm-secret-box'
import { CrmDatabase } from '@/infrastructure/database/drizzle/crm-database'

/**
 * Phase 58 on PostgreSQL: an accepted quote converts its opportunity once, however often
 * the event is delivered; the history folds to the stored record; the quote links are
 * tenant-scoped; and a converted opportunity cannot be reopened.
 */
const clock = { now: () => new Date() }
let database: CrmDatabase
let handlers: CrmModuleEventHandlers
let administrator: ReturnType<typeof postgres>
let application: ReturnType<typeof postgres>

beforeAll(() => {
  database = new CrmDatabase({
    url: process.env.DATABASE_URL ?? '',
    secretBox: new AesGcmSecretBox(),
  })
  handlers = new CrmModuleEventHandlers(database, clock)
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

async function deliver(event: EventEnvelope) {
  const handler = handlers.handlers[event.eventType]
  if (!handler) throw new Error(`no handler for ${event.eventType}`)
  await handler(event)
}

function envelope(
  tenantId: string,
  eventType: string,
  payload: object,
  eventVersion = 1,
): EventEnvelope {
  return {
    eventId: randomUUID(),
    eventType,
    eventVersion,
    occurredAt: new Date().toISOString(),
    tenantId,
    traceId: randomBytes(16).toString('hex'),
    payload,
  }
}

async function workspace() {
  const tenantId = randomUUID()
  const accountId = randomUUID()
  const ownerId = randomUUID()
  await deliver(
    envelope(
      tenantId,
      'parties.party.registered',
      {
        partyId: accountId,
        kind: 'organization',
        legalName: 'Initech Ltda',
        tradeName: null,
        email: 'compras@initech.example',
        phone: '+5511999990000',
        address: 'Rua Um, 42',
        documentType: 'none',
        documentCountry: null,
        roles: ['customer'],
      },
      2,
    ),
  )
  await deliver(
    envelope(tenantId, 'identity.user.registered', {
      tenantId,
      userId: ownerId,
      registeredAt: new Date().toISOString(),
    }),
  )
  const context = { tenantId, actor: ownerId, requestId: null }
  const keyed = () => ({ ...context, idempotencyKey: randomUUID() })
  const { pipelineId } = valid(
    await new CreatePipelineUseCase(database, clock).execute({
      context: keyed(),
      name: 'Vendas',
      stages: [{ name: 'Proposta', probabilityBps: 5000 }],
    }),
  )
  const stageId = (await database.pipelineDetail(tenantId, pipelineId))?.stages[0]?.id ?? ''
  const { opportunityId } = valid(
    await new CreateOpportunityUseCase(database, clock).execute({
      context: keyed(),
      accountId,
      ownerId,
      pipelineId,
      stageId,
      terms: {
        title: 'Licenças 2027',
        expectedValue: { amount: '2500000', currency: 'BRL' },
        expectedCloseOn: '2026-12-15',
      },
    }),
  )
  const quote = (eventType: string, version: number, quoteId: string, quoteRoot: string) =>
    envelope(tenantId, eventType, {
      quoteId,
      quoteRoot,
      version,
      customerId: accountId,
      total: { amount: `${2_700_000 + version * 50_000}`, currency: 'BRL' },
      ...(eventType === 'sales.quote.sent'
        ? { expiresAt: new Date(Date.now() + 86_400_000).toISOString() }
        : {}),
      attribution: { opportunityId, ownerId, sourceId: null },
    })
  return { tenantId, accountId, ownerId, opportunityId, stageId, context, quote }
}

describe('quote conversion on PostgreSQL', () => {
  it('converts once however often the accepted quote arrives, and the history folds to the row', async () => {
    const w = await workspace()
    const root = randomUUID()
    const [first, second] = [randomUUID(), randomUUID()]
    await deliver(w.quote('sales.quote.sent', 1, first, root))
    await deliver(w.quote('sales.quote.sent', 2, second, root))
    const accepted = w.quote('sales.quote.accepted', 2, second, root)
    await Promise.all([deliver(accepted), deliver(accepted)])
    await deliver({ ...accepted, eventId: randomUUID() })

    const detail = await database.opportunityDetail(w.tenantId, w.opportunityId)
    expect(detail?.opportunity).toMatchObject({
      status: 'won',
      expectedValue: { amount: '2800000', currency: 'BRL' },
      conversion: { quoteId: second, quoteRoot: root, quoteVersion: 2 },
    })
    expect(detail?.history.map((recorded) => recorded.fact.type)).toEqual(['created', 'converted'])
    expect(detail?.quotes).toEqual([
      expect.objectContaining({
        quoteRoot: root,
        quoteId: second,
        quoteVersion: 2,
        status: 'accepted',
      }),
    ])
    const { id: _, tenantId: __, ...stored } = detail?.opportunity ?? ({} as never)
    expect(foldHistory(detail?.history ?? [])).toEqual(stored)

    const outbox = await administrator<{ event_type: string }[]>`
      select event_type from outbox where tenant_id = ${w.tenantId} and event_type like 'crm.opportunity.%'
      order by created_at, event_type`
    expect(outbox.map((row) => row.event_type).sort()).toEqual([
      'crm.opportunity.converted',
      'crm.opportunity.created',
      'crm.opportunity.won',
    ])
  })

  it('refuses to reopen it, and the table refuses a conversion on an open opportunity', async () => {
    const w = await workspace()
    await deliver(w.quote('sales.quote.accepted', 1, randomUUID(), randomUUID()))
    const reopened = await new ChangeOpportunityUseCase(database, clock).reopen({
      context: w.context,
      opportunityId: w.opportunityId,
      stageId: w.stageId,
    })
    expect(reopened.isLeft() && reopened.value.message).toMatch(/open a new one/)
    await expect(
      administrator`update opportunities set status = 'open', closed_on = null where id = ${w.opportunityId}`,
    ).rejects.toThrow(/opportunities_conversion/)
  })

  it('keeps quote links inside their tenant', async () => {
    const w = await workspace()
    await deliver(w.quote('sales.quote.sent', 1, randomUUID(), randomUUID()))
    const intruder = randomUUID()
    const visible = await application.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${intruder}, true)`
      return tx`select count(*)::int as n from opportunity_quotes`
    })
    expect(visible[0]?.n).toBe(0)
    const owned =
      await administrator`select count(*)::int as n from opportunity_quotes where tenant_id = ${w.tenantId}`
    expect(owned[0]?.n).toBe(1)
  })
})
