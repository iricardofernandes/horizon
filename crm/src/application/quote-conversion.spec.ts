import { randomBytes, randomUUID } from 'node:crypto'
import type { EventEnvelope } from '@horizon/contracts'
import { InMemoryCrmUnitOfWork } from 'test/repositories/in-memory-crm-unit-of-work'
import { snapshotOf } from 'test/support/snapshot-of'
import { describe, expect, it } from 'vitest'
import type { Either } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { Account } from '@/domain/entities/account'
import { foldHistory, type OpportunitySnapshot } from '@/domain/entities/opportunity'
import { CrmModuleEventHandlers } from './consume-module-events'
import {
  ChangeOpportunityUseCase,
  CreateOpportunityUseCase,
} from './use-cases/manage-opportunities'
import { CreateListEntryUseCase, CreatePipelineUseCase } from './use-cases/manage-pipelines'

function valid<L, R>(result: Either<L, R>): R {
  if (result.isLeft()) throw result.value
  return result.value
}

const now = new Date('2026-09-27T12:00:00Z')
const clock = { now: () => now }

async function world() {
  const unitOfWork = new InMemoryCrmUnitOfWork()
  const handlers = new CrmModuleEventHandlers(unitOfWork, clock).handlers
  const tenantId = randomUUID()
  const accountId = randomUUID()
  const ownerId = randomUUID()
  await unitOfWork.inTenant(tenantId, async (scope) => {
    const account = Account.project(
      {
        tenantId,
        party: {
          kind: 'organization',
          legalName: 'Initech Ltda',
          tradeName: null,
          roles: ['customer'],
          documentType: 'none',
          documentCountry: null,
          active: true,
        },
        now,
      },
      new UniqueEntityID(accountId),
    )
    if (account) await scope.accounts.create(account)
    await scope.owners.register(ownerId, now)
  })
  const context = { tenantId, actor: ownerId, requestId: null }
  const keyed = () => ({ ...context, idempotencyKey: randomUUID() })
  const { pipelineId } = valid(
    await new CreatePipelineUseCase(unitOfWork, clock).execute({
      context: keyed(),
      name: 'Vendas',
      stages: [{ name: 'Proposta', probabilityBps: 5000 }],
    }),
  )
  const stageId =
    (snapshotOf(unitOfWork.pipelines.get(pipelineId) as never) as { stages: { id: string }[] })
      .stages[0]?.id ?? ''
  const lists = new CreateListEntryUseCase(unitOfWork, clock)
  const { entryId: sourceId } = valid(
    await lists.execute({ context: keyed(), kind: 'source', name: 'Indicação' }),
  )
  const { entryId: reasonId } = valid(
    await lists.execute({ context: keyed(), kind: 'loss-reason', name: 'Preço' }),
  )
  const { opportunityId } = valid(
    await new CreateOpportunityUseCase(unitOfWork, clock).execute({
      context: keyed(),
      accountId,
      ownerId,
      pipelineId,
      stageId,
      terms: {
        title: 'Licenças 2027',
        sourceId,
        expectedValue: { amount: '2500000', currency: 'BRL' },
        expectedCloseOn: '2026-12-15',
      },
    }),
  )
  const quoteRoot = randomUUID()
  const quote = (
    eventType: 'sales.quote.sent' | 'sales.quote.accepted' | 'sales.quote.rejected',
    extra: { quoteId?: string; quoteRoot?: string; version?: number; eventId?: string } = {},
  ): EventEnvelope => ({
    eventId: extra.eventId ?? randomUUID(),
    eventType,
    eventVersion: 1,
    occurredAt: '2026-09-26T15:00:00.000Z',
    tenantId,
    traceId: randomBytes(16).toString('hex'),
    payload: {
      quoteId: extra.quoteId ?? randomUUID(),
      quoteRoot: extra.quoteRoot ?? quoteRoot,
      version: extra.version ?? 1,
      customerId: accountId,
      ...(eventType === 'sales.quote.rejected'
        ? { reason: 'Preço' }
        : { total: { amount: '2800000', currency: 'BRL' } }),
      ...(eventType === 'sales.quote.sent' ? { expiresAt: '2026-10-26T15:00:00.000Z' } : {}),
      attribution: { opportunityId, ownerId, sourceId },
    },
  })
  const deliver = async (event: EventEnvelope) => {
    const handler = handlers[event.eventType]
    if (!handler) throw new Error(`CRM does not consume ${event.eventType}`)
    await handler(event)
  }
  const state = () =>
    snapshotOf(unitOfWork.opportunities.get(opportunityId) as never) as OpportunitySnapshot
  const published = () =>
    unitOfWork.published
      .filter((event) => event.aggregateId.toString() === opportunityId)
      .map((event) => event.eventType.replace('crm.opportunity.', ''))
  return {
    unitOfWork,
    tenantId,
    accountId,
    ownerId,
    sourceId,
    reasonId,
    stageId,
    opportunityId,
    quoteRoot,
    context,
    quote,
    deliver,
    state,
    published,
    change: new ChangeOpportunityUseCase(unitOfWork, clock),
  }
}

describe('converting an opportunity from an accepted quote', () => {
  it('wins an open opportunity at the quote total, publishing won then converted', async () => {
    const w = await world()
    const quoteId = randomUUID()
    await w.deliver(w.quote('sales.quote.sent', { quoteId }))
    expect(w.state().status).toBe('open')
    await w.deliver(w.quote('sales.quote.accepted', { quoteId }))
    expect(w.state()).toMatchObject({
      status: 'won',
      closedOn: '2026-09-26',
      expectedValue: { amount: '2800000', currency: 'BRL' },
      conversion: { quoteId, quoteRoot: w.quoteRoot, quoteVersion: 1 },
    })
    expect(w.published()).toEqual(['created', 'won', 'converted'])
    const converted = w.unitOfWork.published.at(-1)?.payloadOf()
    expect(converted).toMatchObject({
      quoteId,
      quoteRoot: w.quoteRoot,
      value: { amount: '2800000', currency: 'BRL' },
      ownerId: w.ownerId,
      sourceId: w.sourceId,
      closedOn: '2026-09-26',
    })
    const history = w.unitOfWork.history.get(w.opportunityId) ?? []
    expect(history.map((recorded) => [recorded.fact.type, recorded.actor])).toEqual([
      ['created', w.ownerId],
      ['converted', 'sales:quote-accepted'],
    ])
    const { id: _, tenantId: __, ...state } = w.state()
    expect(foldHistory(history)).toEqual(state)
    expect(w.unitOfWork.audit.at(-1)).toMatchObject({
      action: 'opportunity.converted',
      actor: 'sales:quote-accepted',
    })
  })

  it('converts once: a replayed or a second accepted quote changes nothing', async () => {
    const w = await world()
    const accepted = w.quote('sales.quote.accepted')
    await w.deliver(accepted)
    await w.deliver(accepted)
    await w.deliver({ ...accepted, eventId: randomUUID() })
    const other = randomUUID()
    await w.deliver(w.quote('sales.quote.accepted', { quoteRoot: other }))
    expect(w.published()).toEqual(['created', 'won', 'converted'])
    expect(w.state().conversion?.quoteRoot).toBe(w.quoteRoot)
    expect(w.unitOfWork.quoteLinks.size).toBe(2)
  })

  it('wins a lost opportunity, keeping the loss in the history', async () => {
    const w = await world()
    valid(
      await w.change.lose({
        context: w.context,
        opportunityId: w.opportunityId,
        lossReasonId: w.reasonId,
      }),
    )
    await w.deliver(w.quote('sales.quote.accepted'))
    expect(w.state()).toMatchObject({ status: 'won', lossReasonId: null, lossNote: null })
    expect(
      (w.unitOfWork.history.get(w.opportunityId) ?? []).map((recorded) => recorded.fact.type),
    ).toEqual(['created', 'lost', 'converted'])
  })

  it('keeps the day an opportunity was won by hand and does not announce a second win', async () => {
    const w = await world()
    valid(await w.change.win({ context: w.context, opportunityId: w.opportunityId }))
    await w.deliver(w.quote('sales.quote.accepted'))
    expect(w.state()).toMatchObject({ status: 'won', closedOn: '2026-09-27' })
    expect(w.published()).toEqual(['created', 'won', 'converted'])
  })

  it('refuses to reopen a converted opportunity', async () => {
    const w = await world()
    await w.deliver(w.quote('sales.quote.accepted'))
    const reopened = await w.change.reopen({
      context: w.context,
      opportunityId: w.opportunityId,
      stageId: w.stageId,
    })
    expect(reopened.isLeft() && reopened.value.message).toMatch(/open a new one/)
  })
})

describe('linking quotes', () => {
  it('keeps the newest version of each offer, and a decision over its sending', async () => {
    const w = await world()
    const second = randomUUID()
    await w.deliver(w.quote('sales.quote.sent', { quoteId: second, version: 2 }))
    await w.deliver(w.quote('sales.quote.sent', { version: 1 }))
    await w.deliver(w.quote('sales.quote.rejected', { quoteId: second, version: 2 }))
    await w.deliver(w.quote('sales.quote.sent', { quoteId: second, version: 2 }))
    const [link] = [...w.unitOfWork.quoteLinks.values()]
    expect(link).toMatchObject({
      quoteId: second,
      quoteVersion: 2,
      status: 'rejected',
      total: { amount: '2800000', currency: 'BRL' },
    })
    expect(w.state().status).toBe('open')
  })

  it('ignores a quote that names no opportunity', async () => {
    const w = await world()
    const event = w.quote('sales.quote.accepted')
    const { attribution: _, ...payload } = event.payload as Record<string, unknown>
    await w.deliver({ ...event, payload })
    expect(w.unitOfWork.quoteLinks.size).toBe(0)
    expect(w.state().status).toBe('open')
  })
})
