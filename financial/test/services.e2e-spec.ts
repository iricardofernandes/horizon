import { randomBytes, randomUUID } from 'node:crypto'
import type { EventEnvelope } from '@horizon/contracts'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FinancialModuleEventHandlers } from '@/application/consume-module-events'
import {
  DefineCategoryUseCase,
  DefinePaymentMethodUseCase,
} from '@/application/use-cases/manage-dimensions'
import {
  PostTitleUseCase,
  RecordSettlementUseCase,
  ReviseTitleUseCase,
} from '@/application/use-cases/manage-titles'
import { FinancialDatabase } from '@/infrastructure/database/drizzle/financial-database'

const clock = { now: () => new Date() }
let database: FinancialDatabase
let administrator: ReturnType<typeof postgres>
let handlers: FinancialModuleEventHandlers

beforeAll(() => {
  database = new FinancialDatabase({ url: process.env.DATABASE_URL ?? '' })
  administrator = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
  handlers = new FinancialModuleEventHandlers(database, clock)
})

afterAll(async () => {
  await Promise.allSettled([database?.close(), administrator?.end()])
})

function value<T>(result: { isLeft(): boolean; value: unknown }): T {
  if (result.isLeft()) throw result.value
  return result.value as T
}

async function deliver(
  tenantId: string,
  eventType: string,
  payload: unknown,
  eventId = randomUUID(),
) {
  const envelope: EventEnvelope = {
    eventId,
    tenantId,
    eventType,
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    traceId: randomBytes(16).toString('hex'),
    payload,
  }
  const handler = handlers.handlers[eventType]
  if (!handler) throw new Error(`no handler for ${eventType}`)
  await handler(envelope)
}

async function workspace() {
  const tenantId = randomUUID()
  const partyId = randomUUID()
  await deliver(tenantId, 'parties.party.registered', {
    partyId,
    kind: 'organization',
    legalName: 'Cliente de Serviços Ltda',
    tradeName: null,
    email: 'financeiro@cliente.example',
    phone: '+5511999990000',
    address: 'Rua Um, 42, São Paulo',
    roles: ['customer'],
  })
  return { tenantId, partyId }
}

const brl = (amount: string) => ({ amount, currency: 'BRL' })

function delivered(partyId: string, amount = '142500') {
  const serviceOrderId = randomUUID()
  const deliveryId = randomUUID()
  return {
    serviceOrderId,
    deliveryId,
    customerId: partyId,
    performedOn: '2026-09-20',
    competence: '2026-09',
    deliveredBy: 'user:operator',
    lines: [
      {
        entryId: randomUUID(),
        lineId: randomUUID(),
        itemId: randomUUID(),
        description: 'Implantação assistida',
        quantity: '1',
        unitPrice: brl('150000'),
        amount: brl(amount),
      },
    ],
    value: brl(amount),
    installments: [
      { number: 1, dueOn: '2026-09-20', amount: brl('71250') },
      { number: 2, dueOn: '2026-10-20', amount: brl('71250') },
    ],
    complete: true,
  }
}

function cancelled(fact: ReturnType<typeof delivered>) {
  return {
    serviceOrderId: fact.serviceOrderId,
    deliveryId: fact.deliveryId,
    customerId: fact.customerId,
    competence: fact.competence,
    entryIds: fact.lines.map((line) => line.entryId),
    cancelledOn: '2026-09-21',
    reason: 'A implantação não aconteceu',
  }
}

const titlesOf = (tenantId: string, deliveryId: string) =>
  administrator`select id, status, stage, document_number from titles
    where tenant_id = ${tenantId} and origin_document_id = ${deliveryId}`

describe('following delivered services', () => {
  it('raises one receivable per delivery, however the fact is replayed', async () => {
    const { tenantId, partyId } = await workspace()
    const fact = delivered(partyId)
    const eventId = randomUUID()
    await deliver(tenantId, 'sales.service.delivered', fact, eventId)
    await deliver(tenantId, 'sales.service.delivered', fact, eventId)
    // The same facts under a new event id still find the delivery's title.
    await deliver(tenantId, 'sales.service.delivered', fact)
    const titles = await titlesOf(tenantId, fact.deliveryId)
    expect(titles).toHaveLength(1)
    expect(titles[0]).toMatchObject({
      status: 'draft',
      stage: 'effective',
      document_number: `SV-${fact.deliveryId.slice(-8).toUpperCase()}`,
    })
    const listed = await database.listTitles(tenantId, 'receivable', {
      view: 'draft',
      today: '2026-09-20',
      limit: 10,
      offset: 0,
    })
    expect(listed.data[0]).toMatchObject({
      total: '142500',
      origin: { type: 'sales-service-delivery', documentId: fact.deliveryId },
    })
  })

  it('withdraws a draft, reverses a posted receivable and flags a settled one', async () => {
    const { tenantId, partyId } = await workspace()
    const draft = delivered(partyId)
    await deliver(tenantId, 'sales.service.delivered', draft)
    await deliver(tenantId, 'sales.service.delivery-cancelled', cancelled(draft))
    expect((await titlesOf(tenantId, draft.deliveryId))[0]).toMatchObject({ status: 'cancelled' })

    const categoryId = value<{ id: string }>(
      await new DefineCategoryUseCase(database, clock).execute({
        tenantId,
        code: '1.02',
        name: 'Receita de serviços',
        nature: 'revenue',
      }),
    ).id
    const context = () => ({
      tenantId,
      actor: 'user-1',
      requestId: null,
      idempotencyKey: randomUUID(),
    })
    const post = async (deliveryId: string) => {
      const [title] = await titlesOf(tenantId, deliveryId)
      const titleId = String(title?.id)
      value(
        await new ReviseTitleUseCase(database, clock, 'receivable').execute({
          context: context(),
          titleId,
          terms: {
            partyId,
            documentNumber: String(title?.document_number),
            currency: 'BRL',
            categoryId,
            issuedOn: '2026-09-20',
            installments: [{ dueOn: '2026-10-20', amount: '142500' }],
          },
        }),
      )
      value(
        await new PostTitleUseCase(database, clock, 'receivable').execute({
          context: context(),
          titleId,
        }),
      )
      return titleId
    }

    const posted = delivered(partyId)
    await deliver(tenantId, 'sales.service.delivered', posted)
    await post(posted.deliveryId)
    await deliver(tenantId, 'sales.service.delivery-cancelled', cancelled(posted))
    expect((await titlesOf(tenantId, posted.deliveryId))[0]).toMatchObject({ status: 'reversed' })
    const [reversal] = await administrator`select payload from outbox
      where tenant_id = ${tenantId} and event_type = 'financial.receivable.reversed'`
    expect(reversal?.payload).toMatchObject({ partyId })
    expect(String(reversal?.payload.reason)).toMatch(/^Service not provided: /)

    const settled = delivered(partyId)
    await deliver(tenantId, 'sales.service.delivered', settled)
    const settledId = await post(settled.deliveryId)
    const paymentMethodId = value<{ id: string }>(
      await new DefinePaymentMethodUseCase(database, clock).execute({
        tenantId,
        kind: 'pix',
        code: 'PIX',
        name: 'Pix',
      }),
    ).id
    value(
      await new RecordSettlementUseCase(database, clock, 'receivable').execute({
        context: context(),
        titleId: settledId,
        settlement: {
          installmentNumber: 1,
          settledOn: '2026-10-01',
          received: '1000',
          paymentMethodId,
        },
      }),
    )
    await deliver(tenantId, 'sales.service.delivery-cancelled', cancelled(settled))
    expect((await titlesOf(tenantId, settled.deliveryId))[0]).toMatchObject({ status: 'posted' })
    const [flag] = await administrator`select action from audit_log
      where tenant_id = ${tenantId} and subject_id = ${settledId}
      order by sequence desc limit 1`
    expect(flag?.action).toBe('receivable.service-cancellation-needs-review')
  })

  it('retries a cancellation that arrives before its delivery', async () => {
    const { tenantId, partyId } = await workspace()
    const fact = delivered(partyId)
    await expect(
      deliver(tenantId, 'sales.service.delivery-cancelled', cancelled(fact)),
    ).rejects.toThrow(/has not been raised yet/)
    // The refused attempt claimed nothing, so the redelivery is handled once it can be.
    await deliver(tenantId, 'sales.service.delivered', fact)
    await deliver(tenantId, 'sales.service.delivery-cancelled', cancelled(fact))
    expect((await titlesOf(tenantId, fact.deliveryId))[0]).toMatchObject({ status: 'cancelled' })
  })
})

function billedPeriod(partyId: string) {
  return {
    contractId: randomUUID(),
    billedPeriodId: randomUUID(),
    customerId: partyId,
    competence: '2026-09',
    revision: 1,
    startsOn: '2026-09-01',
    endsOn: '2026-09-30',
    issuedOn: '2026-09-05',
    lines: delivered(partyId, '90000').lines,
    value: brl('90000'),
    installments: [{ number: 1, dueOn: '2026-09-20', amount: brl('90000') }],
    runId: randomUUID(),
    billedBy: 'user:operator',
  }
}

function credited(fact: ReturnType<typeof billedPeriod>) {
  return {
    contractId: fact.contractId,
    billedPeriodId: fact.billedPeriodId,
    customerId: fact.customerId,
    competence: fact.competence,
    entryIds: fact.lines.map((line) => line.entryId),
    reasonCode: 'billing-error',
    reason: 'Faturado com o posto errado',
    creditedOn: '2026-09-21',
  }
}

describe('following billed contract periods', () => {
  it('raises one receivable per billed period, and withdraws it on a credit', async () => {
    const { tenantId, partyId } = await workspace()
    const fact = billedPeriod(partyId)
    const eventId = randomUUID()
    await deliver(tenantId, 'sales.contract-period.billed', fact, eventId)
    await deliver(tenantId, 'sales.contract-period.billed', fact, eventId)
    await deliver(tenantId, 'sales.contract-period.billed', fact)
    const titles = await titlesOf(tenantId, fact.billedPeriodId)
    expect(titles).toHaveLength(1)
    expect(titles[0]).toMatchObject({
      status: 'draft',
      stage: 'effective',
      document_number: `CT-${fact.billedPeriodId.slice(-8).toUpperCase()}`,
    })
    const listed = await database.listTitles(tenantId, 'receivable', {
      view: 'draft',
      today: '2026-09-20',
      limit: 10,
      offset: 0,
    })
    expect(listed.data[0]).toMatchObject({
      total: '90000',
      origin: { type: 'sales-contract-period', documentId: fact.billedPeriodId },
    })

    await deliver(tenantId, 'sales.contract-period.credited', credited(fact))
    await deliver(tenantId, 'sales.contract-period.credited', credited(fact))
    expect((await titlesOf(tenantId, fact.billedPeriodId))[0]).toMatchObject({
      status: 'cancelled',
    })
    const [withdrawal] = await administrator`select action from audit_log
      where tenant_id = ${tenantId} and subject_id = ${String(titles[0]?.id)}
      order by sequence desc limit 1`
    expect(withdrawal?.action).toBe('receivable.withdrawn-with-credit')
  })

  it('retries a credit that arrives before its billed period', async () => {
    const { tenantId, partyId } = await workspace()
    const fact = billedPeriod(partyId)
    await expect(
      deliver(tenantId, 'sales.contract-period.credited', credited(fact)),
    ).rejects.toThrow(/has not been raised yet/)
    await deliver(tenantId, 'sales.contract-period.billed', fact)
    await deliver(tenantId, 'sales.contract-period.credited', credited(fact))
    expect((await titlesOf(tenantId, fact.billedPeriodId))[0]).toMatchObject({
      status: 'cancelled',
    })
  })
})
