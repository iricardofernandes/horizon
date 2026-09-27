import { randomBytes, randomUUID } from 'node:crypto'
import type { EventEnvelope } from '@horizon/contracts'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CrmModuleEventHandlers } from '@/application/consume-module-events'
import {
  ChangeOpportunityUseCase,
  CreateOpportunityUseCase,
} from '@/application/use-cases/manage-opportunities'
import {
  CreateListEntryUseCase,
  CreatePipelineUseCase,
} from '@/application/use-cases/manage-pipelines'
import { RebuildMetricsUseCase } from '@/application/use-cases/rebuild-metrics'
import { canonicalJson } from '@/core/audit/canonical-json'
import type { Either } from '@/core/either'
import { AesGcmSecretBox } from '@/infrastructure/cryptography/aes-gcm-secret-box'
import { CrmDatabase } from '@/infrastructure/database/drizzle/crm-database'

/**
 * Phase 59 on PostgreSQL: forecast and pipeline metrics checked by hand on a small pipeline;
 * the projections dropped and rebuilt to the same numbers; drift found and repaired; a
 * back-dated fact refused; later facts and replayed events leave an earlier cutoff alone.
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

async function deliver(event: EventEnvelope) {
  const handler = handlers.handlers[event.eventType]
  if (!handler) throw new Error(`no handler for ${event.eventType}`)
  await handler(event)
}

/**
 * Four opportunities on stages A (10%), B (50%) and C (80%):
 * 1. 100 000 due 2026-12, moved A→B, open;
 * 2. 200 000 due 2026-12, moved A→B→C and won;
 * 3.  50 000 due 2027-01, lost in A for "price";
 * 4.  30 000 due 2026-12, lost in A for "timing", then reopened in B.
 */
async function pipeline() {
  const tenantId = randomUUID()
  const accountId = randomUUID()
  const [ownerOne, ownerTwo] = [randomUUID(), randomUUID()]
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
  for (const userId of [ownerOne, ownerTwo])
    await deliver(
      envelope(tenantId, 'identity.user.registered', {
        tenantId,
        userId,
        registeredAt: new Date().toISOString(),
      }),
    )
  const context = { tenantId, actor: ownerOne ?? '', requestId: null }
  const keyed = () => ({ ...context, idempotencyKey: randomUUID() })
  const { pipelineId } = valid(
    await new CreatePipelineUseCase(database, clock).execute({
      context: keyed(),
      name: 'Vendas',
      stages: [
        { name: 'A', probabilityBps: 1000 },
        { name: 'B', probabilityBps: 5000 },
        { name: 'C', probabilityBps: 8000 },
      ],
    }),
  )
  const [a, b, c] = ((await database.pipelineDetail(tenantId, pipelineId))?.stages ?? []).map(
    (stage) => stage.id,
  )
  const lists = new CreateListEntryUseCase(database, clock)
  const { entryId: price } = valid(
    await lists.execute({ context: keyed(), kind: 'loss-reason', name: 'Preço' }),
  )
  const { entryId: timing } = valid(
    await lists.execute({ context: keyed(), kind: 'loss-reason', name: 'Prazo' }),
  )
  const open = async (amount: string, closeOn: string, ownerId: string) =>
    valid(
      await new CreateOpportunityUseCase(database, clock).execute({
        context: keyed(),
        accountId,
        ownerId,
        pipelineId,
        stageId: a ?? '',
        terms: {
          title: `Oportunidade ${amount}`,
          expectedValue: { amount, currency: 'BRL' },
          expectedCloseOn: closeOn,
        },
      }),
    ).opportunityId
  const change = new ChangeOpportunityUseCase(database, clock)
  const move = (opportunityId: string, stageId?: string) =>
    change.move({ context, opportunityId, stageId: stageId ?? '' }).then(valid)

  const first = await open('100000', '2026-12-15', ownerOne ?? '')
  await move(first, b)
  const second = await open('200000', '2026-12-20', ownerOne ?? '')
  await move(second, b)
  await move(second, c)
  valid(await change.win({ context, opportunityId: second }))
  const third = await open('50000', '2027-01-10', ownerTwo ?? '')
  valid(await change.lose({ context, opportunityId: third, lossReasonId: price }))
  const fourth = await open('30000', '2026-12-01', ownerTwo ?? '')
  valid(await change.lose({ context, opportunityId: fourth, lossReasonId: timing }))
  valid(await change.reopen({ context, opportunityId: fourth, stageId: b ?? '' }))
  return {
    tenantId,
    accountId,
    pipelineId,
    a,
    b,
    c,
    price,
    timing,
    first,
    second,
    third,
    fourth,
    ownerOne,
    ownerTwo,
    context,
    change,
  }
}

const thisMonth = () => new Date().toISOString().slice(0, 7)

describe('forecast and pipeline metrics on PostgreSQL', () => {
  it('gives the numbers worked out by hand', async () => {
    const p = await pipeline()
    const cutoff = new Date()
    const forecast = await database.forecast(p.tenantId, {
      cutoff,
      groupBy: 'pipeline',
      pipelineId: null,
      ownerId: null,
      sourceId: null,
    })
    expect(forecast).toEqual(
      [
        {
          month: '2026-12',
          key: p.pipelineId,
          currency: 'BRL',
          openCount: 2,
          openValue: '130000',
          weightedValue: '65000',
          wonCount: 0,
          wonValue: '0',
        },
        {
          month: thisMonth(),
          key: p.pipelineId,
          currency: 'BRL',
          openCount: 0,
          openValue: '0',
          weightedValue: '0',
          wonCount: 1,
          wonValue: '200000',
        },
      ].sort((x, y) => x.month.localeCompare(y.month)),
    )

    const byOwner = await database.forecast(p.tenantId, {
      cutoff,
      groupBy: 'owner',
      pipelineId: p.pipelineId,
      ownerId: p.ownerTwo ?? null,
      sourceId: null,
    })
    expect(byOwner.map((row) => [row.month, row.key, row.openValue, row.weightedValue])).toEqual([
      ['2026-12', p.ownerTwo, '30000', '15000'],
    ])

    const metrics = await database.pipelineMetrics(p.tenantId, {
      pipelineId: p.pipelineId,
      from: new Date(0),
      to: cutoff,
      cutoff,
    })
    expect(
      metrics.stages.map((stage) => [stage.stageId, stage.entered, stage.current, stage.exits]),
    ).toEqual([
      [p.a, 4, 0, { moved: 2, won: 0, lost: 2 }],
      [p.b, 3, 2, { moved: 1, won: 0, lost: 0 }],
      [p.c, 1, 0, { moved: 0, won: 1, lost: 0 }],
    ])
    expect(metrics.conversions).toEqual(
      [
        { fromStageId: p.a, toStageId: p.b, count: 2 },
        { fromStageId: p.b, toStageId: p.c, count: 1 },
      ].sort((x, y) => (x.fromStageId ?? '').localeCompare(y.fromStageId ?? '')),
    )
    // The loss of the fourth was reopened: only the third's loss still counts.
    expect(metrics.outcomes).toEqual({ won: 1, lost: 1, winRateBps: 5000 })
    expect(metrics.lossReasons).toEqual([{ lossReasonId: p.price, count: 1 }])
    expect(metrics.stages[0]?.timeInStage.count).toBe(4)
  })

  it('rebuilds the same numbers after the projections are dropped, and repairs drift', async () => {
    const p = await pipeline()
    const cutoff = new Date()
    const live = canonicalJson(await database.metricNumbers(p.tenantId, cutoff))
    const rebuild = new RebuildMetricsUseCase(database, 2)
    expect(await rebuild.execute(p.tenantId, { verifyOnly: true })).toMatchObject({
      processed: 4,
      drifted: 0,
    })

    for (const table of ['metric_states', 'metric_stage_visits', 'metric_closures'])
      await administrator`delete from ${administrator(table)} where tenant_id = ${p.tenantId}`
    expect(canonicalJson(await database.metricNumbers(p.tenantId, cutoff))).not.toBe(live)
    const progress: number[] = []
    expect(
      await rebuild.execute(p.tenantId, { onBatch: (step) => progress.push(step.processed) }),
    ).toMatchObject({ processed: 4, drifted: 4 })
    expect(progress).toEqual([2, 4])
    expect(canonicalJson(await database.metricNumbers(p.tenantId, cutoff))).toBe(live)

    await administrator`update metric_states set amount = 1 where tenant_id = ${p.tenantId} and opportunity_id = ${p.first}`
    expect(await rebuild.execute(p.tenantId, { verifyOnly: true })).toMatchObject({
      drifted: 1,
      driftedIds: [p.first],
    })
    await rebuild.execute(p.tenantId)
    expect(canonicalJson(await database.metricNumbers(p.tenantId, cutoff))).toBe(live)
  })

  it('keeps an earlier cutoff as it was: back-dated facts are refused, later and replayed ones do not count', async () => {
    const p = await pipeline()
    // A quote accepted for the first opportunity converts it before the cutoff.
    const accepted = envelope(p.tenantId, 'sales.quote.accepted', {
      quoteId: randomUUID(),
      quoteRoot: randomUUID(),
      version: 1,
      customerId: p.accountId,
      total: { amount: '110000', currency: 'BRL' },
      attribution: { opportunityId: p.first, ownerId: p.ownerOne, sourceId: null },
    })
    await deliver(accepted)
    const cutoff = new Date()
    const before = canonicalJson(await database.metricNumbers(p.tenantId, cutoff))

    await expect(
      administrator`insert into opportunity_events (tenant_id, opportunity_id, sequence, type, fact, actor, occurred_at)
        values (${p.tenantId}, ${p.second}, 99, 'lost', '{}'::jsonb, 'x', now() - interval '1 hour')`,
    ).rejects.toThrow(/recorded at the instant it happens/)
    await expect(
      administrator`insert into opportunity_events (tenant_id, opportunity_id, sequence, type, fact, actor, occurred_at)
        values (${p.tenantId}, ${p.second}, 99, 'lost', '{}'::jsonb, 'x', now() + interval '1 hour')`,
    ).rejects.toThrow(/recorded at the instant it happens/)

    await new Promise((resolve) => setTimeout(resolve, 5))
    await deliver(accepted)
    await deliver({ ...accepted, eventId: randomUUID() })
    valid(
      await p.change.lose({ context: p.context, opportunityId: p.fourth, lossReasonId: p.price }),
    )
    expect(canonicalJson(await database.metricNumbers(p.tenantId, cutoff))).toBe(before)
    const now = await database.pipelineMetrics(p.tenantId, {
      pipelineId: p.pipelineId,
      from: new Date(0),
      to: new Date(),
      cutoff: new Date(),
    })
    expect(now.outcomes).toEqual({ won: 2, lost: 2, winRateBps: 5000 })
  })

  it('keeps the projections inside their tenant', async () => {
    const p = await pipeline()
    const intruder = randomUUID()
    for (const table of ['metric_states', 'metric_stage_visits', 'metric_closures']) {
      const visible = await application.begin(async (tx) => {
        await tx`select set_config('app.current_tenant', ${intruder}, true)`
        return tx`select count(*)::int as n from ${tx(table)}`
      })
      expect(visible[0]?.n, table).toBe(0)
    }
    expect(
      await database.forecast(intruder, {
        cutoff: new Date(),
        groupBy: 'pipeline',
        pipelineId: null,
        ownerId: null,
        sourceId: null,
      }),
    ).toEqual([])
    expect(p.tenantId).not.toBe(intruder)
  })
})
