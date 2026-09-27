import { randomBytes, randomUUID } from 'node:crypto'
import type { EventEnvelope } from '@horizon/contracts'
import { InMemorySalesUnitOfWork } from 'test/repositories/in-memory-sales-unit-of-work'
import { snapshotOf } from 'test/support/snapshot-of'
import { Currency, LineDescription, Money } from '@/domain/value-objects/sales-values'
import { SalesModuleEventHandlers } from './consume-module-events'
import type { IdempotentContext } from './use-cases/commands'
import {
  DecideQuoteUseCase,
  ReviseQuoteUseCase,
  WriteQuoteUseCase,
} from './use-cases/manage-quotes'
import { ProjectPartyUseCase } from './use-cases/project-parties'

function unwrap<T>(result: { isLeft(): boolean; value: T }): T {
  if (result.isLeft()) throw result.value
  return result.value
}

const now = new Date('2026-09-27T20:00:00.000Z')
const clock = { now: () => now }
const brl = unwrap(Currency.create('BRL'))

function commandOf(tenantId: string): IdempotentContext {
  return { tenantId, actor: 'ana', requestId: null, idempotencyKey: randomUUID() }
}

async function world() {
  const unitOfWork = new InMemorySalesUnitOfWork()
  const handlers = new SalesModuleEventHandlers(unitOfWork, clock).handlers
  const tenantId = randomUUID()
  const customerId = randomUUID()
  unwrap(
    await unitOfWork.inTenant(tenantId, (scope) =>
      new ProjectPartyUseCase(clock).executeInScope(scope, {
        tenantId,
        partyId: customerId,
        legalName: 'Initech Ltda',
        email: 'compras@initech.example',
        phone: '+5511999990000',
        address: 'Rua Um, 42',
        roles: ['customer'],
        active: true,
      }),
    ),
  )
  const itemId = randomUUID()
  unitOfWork.catalogItems.push({
    tenantId,
    itemId,
    description: unwrap(LineDescription.create('Licença')),
    unitPrice: unwrap(Money.create('100000', brl)),
    active: true,
  })
  const deliver = async (eventType: string, occurredAt: string, payload: object) => {
    const handler = handlers[eventType]
    if (!handler) throw new Error(`Sales does not consume ${eventType}`)
    const event: EventEnvelope = {
      eventId: randomUUID(),
      eventType,
      eventVersion: 1,
      occurredAt,
      tenantId,
      traceId: randomBytes(16).toString('hex'),
      payload,
    }
    await handler(event)
  }
  const opportunityId = randomUUID()
  const ownerId = randomUUID()
  const sourceId = randomUUID()
  const opened = {
    opportunityId,
    accountId: customerId,
    pipelineId: randomUUID(),
    stageId: randomUUID(),
    probabilityBps: 1000,
    ownerId,
    sourceId,
    expectedValue: { amount: '100000', currency: 'BRL' },
    expectedCloseOn: '2026-12-01',
  }
  const write = (extra: object = {}) =>
    new WriteQuoteUseCase(unitOfWork, clock, 15).execute({
      context: commandOf(tenantId),
      customerId,
      quote: { lines: [{ lineId: randomUUID(), itemId, quantity: '1' }] },
      ...extra,
    })
  return {
    unitOfWork,
    tenantId,
    customerId,
    itemId,
    opportunityId,
    ownerId,
    sourceId,
    opened,
    deliver,
    write,
  }
}

describe('quote attribution', () => {
  it('freezes the owner and source Sales projected, on every version and every event', async () => {
    const w = await world()
    await w.deliver('crm.opportunity.created', '2026-09-27T10:00:00.000Z', w.opened)
    const { quoteId } = unwrap(await w.write({ opportunityId: w.opportunityId }))
    const decide = new DecideQuoteUseCase(w.unitOfWork, clock)
    unwrap(await decide.send(commandOf(w.tenantId), quoteId))

    // The opportunity changes hands after the offer was made: the offer keeps its owner.
    const newOwner = randomUUID()
    await w.deliver('crm.opportunity.owner-changed', '2026-09-27T11:00:00.000Z', {
      opportunityId: w.opportunityId,
      accountId: w.customerId,
      fromOwnerId: w.ownerId,
      toOwnerId: newOwner,
    })
    const next = unwrap(
      await new ReviseQuoteUseCase(w.unitOfWork, clock, 15).execute({
        context: commandOf(w.tenantId),
        quoteId,
        quote: { lines: [{ lineId: randomUUID(), itemId: w.itemId, quantity: '2' }] },
      }),
    )
    unwrap(await decide.send(commandOf(w.tenantId), next.quoteId))
    unwrap(await decide.accept(commandOf(w.tenantId), next.quoteId))

    const attribution = { opportunityId: w.opportunityId, ownerId: w.ownerId, sourceId: w.sourceId }
    const versions = w.unitOfWork.quotes.map((quote) => snapshotOf(quote))
    expect(versions.map((quote) => [quote.version, quote.attribution])).toEqual([
      [1, attribution],
      [2, attribution],
    ])
    const quoteEvents = w.unitOfWork.events.filter((event) =>
      event.eventType.startsWith('sales.quote.'),
    )
    expect(quoteEvents.map((event) => event.eventType)).toEqual([
      'sales.quote.sent',
      'sales.quote.sent',
      'sales.quote.accepted',
    ])
    for (const event of quoteEvents) expect(event.payloadOf().attribution).toEqual(attribution)
  })

  it('refuses an opportunity it does not know, of another customer, or no longer open', async () => {
    const w = await world()
    const unknown = await w.write({ opportunityId: w.opportunityId })
    expect(unknown.isLeft() && unknown.value.message).toMatch(/not known to Sales/)

    await w.deliver('crm.opportunity.created', '2026-09-27T10:00:00.000Z', {
      ...w.opened,
      accountId: randomUUID(),
    })
    const foreign = await w.write({ opportunityId: w.opportunityId })
    expect(foreign.isLeft() && foreign.value.message).toMatch(/another customer/)

    const lost = randomUUID()
    await w.deliver('crm.opportunity.created', '2026-09-27T10:00:00.000Z', {
      ...w.opened,
      opportunityId: lost,
    })
    await w.deliver('crm.opportunity.lost', '2026-09-27T12:00:00.000Z', {
      opportunityId: lost,
      accountId: w.customerId,
      pipelineId: w.opened.pipelineId,
      stageId: w.opened.stageId,
      ownerId: w.ownerId,
      sourceId: null,
      value: { amount: '100000', currency: 'BRL' },
      closedOn: '2026-09-27',
      lossReasonId: randomUUID(),
    })
    const closed = await w.write({ opportunityId: lost })
    expect(closed.isLeft() && closed.value.message).toMatch(/is lost/)
  })

  it('leaves a quote without an opportunity, and its events, as they were', async () => {
    const w = await world()
    const { quoteId } = unwrap(await w.write())
    unwrap(await new DecideQuoteUseCase(w.unitOfWork, clock).send(commandOf(w.tenantId), quoteId))
    expect(snapshotOf(w.unitOfWork.quotes[0] as never)).toMatchObject({ attribution: null })
    const [sent] = w.unitOfWork.events.filter((event) => event.eventType === 'sales.quote.sent')
    expect(sent?.payloadOf()).not.toHaveProperty('attribution')
  })
})

describe('the opportunity projection', () => {
  it('keeps the latest value of each field whatever order the facts arrive in', async () => {
    const w = await world()
    const later = randomUUID()
    // The owner change and the loss arrive before the creation that preceded them.
    await w.deliver('crm.opportunity.owner-changed', '2026-09-27T11:00:00.000Z', {
      opportunityId: w.opportunityId,
      accountId: w.customerId,
      fromOwnerId: w.ownerId,
      toOwnerId: later,
    })
    await w.deliver('crm.opportunity.revised', '2026-09-27T11:30:00.000Z', {
      opportunityId: w.opportunityId,
      accountId: w.customerId,
      sourceId: null,
      expectedValue: { amount: '1', currency: 'BRL' },
      expectedCloseOn: '2026-12-01',
    })
    await w.deliver('crm.opportunity.created', '2026-09-27T10:00:00.000Z', w.opened)
    const view = await w.unitOfWork.inTenant(w.tenantId, (scope) =>
      scope.opportunities.find(w.opportunityId),
    )
    expect(view).toEqual({
      id: w.opportunityId,
      accountId: w.customerId,
      ownerId: later,
      sourceId: null,
      status: 'open',
    })
  })
})
