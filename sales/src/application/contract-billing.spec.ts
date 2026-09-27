import { randomUUID } from 'node:crypto'
import { InMemorySalesUnitOfWork } from 'test/repositories/in-memory-sales-unit-of-work'
import { Currency, LineDescription, Money } from '@/domain/value-objects/sales-values'
import type { BillingMetrics } from './ports/billing-metrics'
import type { IdempotentContext } from './use-cases/commands'
import {
  BillPeriodUseCase,
  CreditPeriodUseCase,
  PreviewBillingRunUseCase,
  ProcessBillingRunUseCase,
  StartBillingRunUseCase,
} from './use-cases/contract-billing'
import { ProjectPartyUseCase } from './use-cases/project-parties'
import {
  CreateContractUseCase,
  DecideContractUseCase,
  RenewDueContractsUseCase,
} from './use-cases/service-contracts'

function unwrap<T>(result: { isLeft(): boolean; value: T }): T {
  if (result.isLeft()) throw result.value
  return result.value
}

const brl = unwrap(Currency.create('BRL'))
const now = new Date('2026-09-20T15:00:00.000Z')
const clock = { now: () => now }

function commandOf(tenantId: string, idempotencyKey = randomUUID()): IdempotentContext {
  return { tenantId, actor: 'ana', requestId: null, idempotencyKey }
}

async function project(
  unitOfWork: InMemorySalesUnitOfWork,
  tenantId: string,
  partyId: string,
  active: boolean,
) {
  unwrap(
    await unitOfWork.inTenant(tenantId, (scope) =>
      new ProjectPartyUseCase(clock).executeInScope(scope, {
        tenantId,
        partyId,
        legalName: 'Cliente Recorrente',
        email: 'recorrente@example.com',
        phone: '+5511999999999',
        address: 'Rua Um, 42',
        roles: ['customer'],
        active,
      }),
    ),
  )
}

async function customer(unitOfWork: InMemorySalesUnitOfWork, tenantId: string) {
  const customerId = randomUUID()
  await project(unitOfWork, tenantId, customerId, true)
  return customerId
}

function service(unitOfWork: InMemorySalesUnitOfWork, tenantId: string) {
  const itemId = randomUUID()
  unitOfWork.catalogItems.push({
    tenantId,
    itemId,
    description: unwrap(LineDescription.create('Suporte')),
    unitPrice: unwrap(Money.create('50000', brl)),
    active: true,
    kind: 'service',
  })
  return itemId
}

async function activeContract(
  unitOfWork: InMemorySalesUnitOfWork,
  tenantId: string,
  input: { customerId: string; itemId: string; billingDay?: number },
) {
  const { contractId } = unwrap(
    await new CreateContractUseCase(unitOfWork, clock).execute({
      context: commandOf(tenantId),
      customerId: input.customerId,
      lines: [{ lineId: randomUUID(), itemId: input.itemId, quantity: '2' }],
      recurrence: 'monthly',
      startsOn: '2026-08-01',
      billingDay: input.billingDay ?? 5,
      paymentTermDays: [15],
    }),
  )
  unwrap(
    await new DecideContractUseCase(unitOfWork, clock).activate(
      { tenantId, actor: 'ana', requestId: null },
      contractId,
    ),
  )
  return contractId
}

function billing(unitOfWork: InMemorySalesUnitOfWork, metrics?: BillingMetrics) {
  const process = new ProcessBillingRunUseCase(unitOfWork, clock, metrics)
  return {
    process,
    start: (processing: Pick<ProcessBillingRunUseCase, 'execute'> = process) =>
      new StartBillingRunUseCase(
        unitOfWork,
        clock,
        new RenewDueContractsUseCase(unitOfWork, clock),
        processing,
      ),
    preview: new PreviewBillingRunUseCase(unitOfWork, clock),
  }
}

const billedEvents = (unitOfWork: InMemorySalesUnitOfWork) =>
  unitOfWork.events.filter((event) => event.eventType === 'sales.contract-period.billed')

async function scenario() {
  const unitOfWork = new InMemorySalesUnitOfWork()
  const tenantId = randomUUID()
  const itemId = service(unitOfWork, tenantId)
  const customerId = await customer(unitOfWork, tenantId)
  const due = await activeContract(unitOfWork, tenantId, { customerId, itemId })
  const late = await activeContract(unitOfWork, tenantId, { customerId, itemId, billingDay: 25 })
  const blocked = await activeContract(unitOfWork, tenantId, {
    customerId: await customer(unitOfWork, tenantId),
    itemId,
  })
  return { unitOfWork, tenantId, itemId, due, late, blocked }
}

describe('billing runs', () => {
  it('previews what a month would bill and skip, writing nothing', async () => {
    const { unitOfWork, tenantId, due, late } = await scenario()
    const preview = unwrap(
      await billing(unitOfWork).preview.execute(
        { tenantId, actor: 'ana', requestId: null },
        '2026-09',
      ),
    )
    const outcomes = new Map(preview.items.map((item) => [item.contractId, item]))
    expect(outcomes.get(due)).toMatchObject({
      outcome: 'billed',
      reason: null,
      billingOn: '2026-09-05',
      amount: { amount: '100000', currency: 'BRL' },
    })
    expect(outcomes.get(late)).toMatchObject({ outcome: 'skipped', reason: 'not-due-yet' })
    expect(preview.items).toHaveLength(3)
    expect(billedEvents(unitOfWork)).toHaveLength(0)
    expect(unitOfWork.billingRuns.size).toBe(0)
  })

  it('refuses a month that has not begun', async () => {
    const { unitOfWork, tenantId } = await scenario()
    const result = await billing(unitOfWork)
      .start()
      .execute({ context: commandOf(tenantId), competence: '2026-10' })
    expect(result.isLeft()).toBe(true)
  })

  it('bills each due contract once, however the month is re-run', async () => {
    const { unitOfWork, tenantId, due, blocked, late } = await scenario()
    const decided: string[] = []
    const durations: number[] = []
    const metrics: BillingMetrics = {
      decided: (outcome, reason) => decided.push(`${outcome}:${reason ?? '-'}`),
      runFinished: (seconds) => durations.push(seconds),
    }
    const { start } = billing(unitOfWork, metrics)
    const key = randomUUID()
    const run = unwrap(
      await start().execute({ context: commandOf(tenantId, key), competence: '2026-09' }),
    )
    expect(run.status).toBe('completed')
    const outcomes = new Map(run.items.map((item) => [item.contractId, item]))
    expect(outcomes.get(due)).toMatchObject({ outcome: 'billed' })
    expect(outcomes.get(blocked)).toMatchObject({ outcome: 'billed' })
    expect(outcomes.get(late)).toMatchObject({ outcome: 'skipped', reason: 'not-due-yet' })
    expect(billedEvents(unitOfWork)).toHaveLength(2)
    expect(decided.sort()).toEqual(['billed:-', 'billed:-', 'skipped:not-due-yet'])
    expect(durations).toHaveLength(1)

    const again = unwrap(
      await start().execute({ context: commandOf(tenantId, key), competence: '2026-09' }),
    )
    expect(again.id).toBe(run.id)
    const other = unwrap(
      await start().execute({ context: commandOf(tenantId), competence: '2026-09' }),
    )
    expect(other.id).not.toBe(run.id)
    expect(other.items.filter((item) => item.reason === 'already-billed')).toHaveLength(2)
    expect(billedEvents(unitOfWork)).toHaveLength(2)
    expect(durations).toHaveLength(2)

    const august = unwrap(
      await start().execute({ context: commandOf(tenantId), competence: '2026-08' }),
    )
    expect(august.items.map((item) => item.outcome)).toEqual(['billed', 'billed', 'billed'])
    expect(billedEvents(unitOfWork)).toHaveLength(5)
  })

  it('finishes a run stopped midway without billing anything twice', async () => {
    const { unitOfWork, tenantId } = await scenario()
    const { process, start } = billing(unitOfWork)
    const stopsAfterOne = {
      execute: (context: Parameters<ProcessBillingRunUseCase['execute']>[0], runId: string) =>
        process.execute(context, runId, { limit: 1 }),
    }
    const stopped = unwrap(
      await start(stopsAfterOne).execute({ context: commandOf(tenantId), competence: '2026-09' }),
    )
    expect(stopped.status).toBe('running')
    expect(stopped.items.filter((item) => item.outcome === 'pending')).toHaveLength(1)
    expect(billedEvents(unitOfWork)).toHaveLength(1)
    const resumed = unwrap(
      await process.execute({ tenantId, actor: 'ana', requestId: null }, stopped.id),
    )
    expect(resumed.status).toBe('completed')
    expect(resumed.items.filter((item) => item.outcome === 'billed')).toHaveLength(2)
    expect(billedEvents(unitOfWork)).toHaveLength(2)
    const payloads = billedEvents(unitOfWork).map((event) => event.payloadOf())
    expect(new Set(payloads.map((payload) => payload.contractId)).size).toBe(2)
    expect(payloads.every((payload) => payload.runId === stopped.id)).toBe(true)
  })

  it('lists a contract whose customer left or whose service is gone as refused, with why', async () => {
    const { unitOfWork, tenantId, due, blocked } = await scenario()
    const other = service(unitOfWork, tenantId)
    const withOther = await activeContract(unitOfWork, tenantId, {
      customerId: await customer(unitOfWork, tenantId),
      itemId: other,
    })
    const gone = unitOfWork.catalogItems.find((item) => item.itemId === other)
    if (gone) Object.assign(gone, { active: false })
    const leaving = unitOfWork.contracts.find((each) => each.id.toString() === blocked)
    await project(unitOfWork, tenantId, leaving?.customerId ?? '', false)
    const run = unwrap(
      await billing(unitOfWork)
        .start()
        .execute({ context: commandOf(tenantId), competence: '2026-09' }),
    )
    const outcomes = new Map(run.items.map((item) => [item.contractId, item]))
    expect(outcomes.get(due)).toMatchObject({ outcome: 'billed' })
    expect(outcomes.get(blocked)).toMatchObject({
      outcome: 'refused',
      reason: 'customer-inactive',
    })
    expect(outcomes.get(withOther)).toMatchObject({
      outcome: 'refused',
      reason: 'service-unavailable',
    })
  })
})

describe('billing and crediting one period', () => {
  it('bills a period once per key and credits it in full, keeping it', async () => {
    const { unitOfWork, tenantId, due } = await scenario()
    const key = randomUUID()
    const bill = new BillPeriodUseCase(unitOfWork, clock)
    const billed = unwrap(
      await bill.execute({
        context: commandOf(tenantId, key),
        contractId: due,
        competence: '2026-09',
      }),
    )
    const replayed = unwrap(
      await bill.execute({
        context: commandOf(tenantId, key),
        contractId: due,
        competence: '2026-09',
      }),
    )
    expect(replayed).toEqual(billed)
    const twice = await bill.execute({
      context: commandOf(tenantId),
      contractId: due,
      competence: '2026-09',
    })
    expect(twice).toMatchObject({ value: { message: 'this period was already billed' } })

    const credit = new CreditPeriodUseCase(unitOfWork, clock)
    const wrong = await credit.execute({
      context: commandOf(tenantId),
      contractId: due,
      competence: '2026-09',
      reasonCode: 'other',
      reason: 'Motivo qualquer',
    })
    expect(wrong.isLeft()).toBe(true)
    const credited = unwrap(
      await credit.execute({
        context: commandOf(tenantId),
        contractId: due,
        competence: '2026-09',
        reasonCode: 'billing-error',
        reason: 'Faturado com a quantidade errada',
      }),
    )
    expect(credited.billedPeriodId).toBe(billed.billedPeriodId)
    const credits = unitOfWork.events.filter(
      (event) => event.eventType === 'sales.contract-period.credited',
    )
    expect(credits.map((event) => event.payloadOf().reasonCode)).toEqual(['billing-error'])
    const contract = unitOfWork.contracts.find((each) => each.id.toString() === due)
    expect(contract?.billedPeriods()).toHaveLength(1)
    expect(unitOfWork.auditRecords.map((record) => record.action)).toEqual(
      expect.arrayContaining(['contract.period-billed', 'contract.period-credited']),
    )
  })
})
