import { randomUUID } from 'node:crypto'
import { InMemorySalesUnitOfWork } from 'test/repositories/in-memory-sales-unit-of-work'
import { snapshotOf } from 'test/support/snapshot-of'
import { Currency, LineDescription, Money } from '@/domain/value-objects/sales-values'
import type { IdempotentContext } from './use-cases/commands'
import { ProjectPartyUseCase } from './use-cases/project-parties'
import {
  AmendContractUseCase,
  CreateContractUseCase,
  DecideContractUseCase,
  RenewContractUseCase,
  RenewDueContractsUseCase,
} from './use-cases/service-contracts'

function unwrap<T>(result: { isLeft(): boolean; value: T }): T {
  if (result.isLeft()) throw result.value
  return result.value
}

const brl = unwrap(Currency.create('BRL'))
let now = new Date('2026-09-20T15:00:00.000Z')
const clock = { now: () => now }

function commandOf(tenantId: string): IdempotentContext {
  return { tenantId, actor: 'ana', requestId: null, idempotencyKey: randomUUID() }
}

async function seed(unitOfWork: InMemorySalesUnitOfWork) {
  const tenantId = randomUUID()
  const customerId = randomUUID()
  unwrap(
    await unitOfWork.inTenant(tenantId, (scope) =>
      new ProjectPartyUseCase(clock).executeInScope(scope, {
        tenantId,
        partyId: customerId,
        legalName: 'Cliente Recorrente',
        email: 'recorrente@example.com',
        phone: '+5511999999999',
        address: 'Rua Um, 42',
        roles: ['customer'],
        active: true,
      }),
    ),
  )
  const item = (kind: 'service' | 'product') => {
    const itemId = randomUUID()
    unitOfWork.catalogItems.push({
      tenantId,
      itemId,
      description: unwrap(LineDescription.create(kind === 'service' ? 'Suporte' : 'Café')),
      unitPrice: unwrap(Money.create('50000', brl)),
      active: true,
      kind,
    })
    return itemId
  }
  return { tenantId, customerId, service: item('service'), good: item('product') }
}

describe('service contracts', () => {
  beforeEach(() => {
    now = new Date('2026-09-20T15:00:00.000Z')
  })

  it('drafts services only, at a negotiated price, and activates once', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const fixture = await seed(unitOfWork)
    const create = new CreateContractUseCase(unitOfWork, clock)
    const base = {
      customerId: fixture.customerId,
      recurrence: 'monthly' as const,
      startsOn: '2026-10-01',
      endsOn: '2027-09-30',
      billingDay: 10,
      autoRenew: true,
    }
    const withGoods = await create.execute({
      ...base,
      context: commandOf(fixture.tenantId),
      lines: [{ lineId: randomUUID(), itemId: fixture.good, quantity: '1' }],
    })
    expect(withGoods.isLeft()).toBe(true)
    const { contractId } = unwrap(
      await create.execute({
        ...base,
        context: commandOf(fixture.tenantId),
        lines: [
          { lineId: randomUUID(), itemId: fixture.service, quantity: '2', unitPrice: '45000' },
        ],
      }),
    )
    const decide = new DecideContractUseCase(unitOfWork, clock)
    expect(unwrap(await decide.activate(commandOf(fixture.tenantId), contractId)).status).toBe(
      'active',
    )
    expect((await decide.activate(commandOf(fixture.tenantId), contractId)).isLeft()).toBe(true)
    const snapshot = snapshotOf(
      unitOfWork.contracts[0] as NonNullable<(typeof unitOfWork.contracts)[0]>,
    )
    expect(snapshot.revisions[0]?.lines[0]).toMatchObject({ quantity: '2', unitPrice: '45000' })
    expect(unitOfWork.events.map((event) => event.eventType)).toContain('sales.contract.activated')
  })

  it('amends, suspends, resumes, renews and cancels through the use cases', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const fixture = await seed(unitOfWork)
    const { contractId } = unwrap(
      await new CreateContractUseCase(unitOfWork, clock).execute({
        context: commandOf(fixture.tenantId),
        customerId: fixture.customerId,
        lines: [{ lineId: randomUUID(), itemId: fixture.service, quantity: '1' }],
        recurrence: 'monthly',
        startsOn: '2026-10-01',
        endsOn: '2027-09-30',
        billingDay: 10,
        autoRenew: true,
      }),
    )
    const decide = new DecideContractUseCase(unitOfWork, clock)
    unwrap(await decide.activate(commandOf(fixture.tenantId), contractId))
    const amended = unwrap(
      await new AmendContractUseCase(unitOfWork, clock).execute({
        context: commandOf(fixture.tenantId),
        contractId,
        effectiveFrom: '2026-12-01',
        lines: [{ lineId: randomUUID(), itemId: fixture.service, quantity: '3' }],
        recurrence: 'monthly',
        reason: 'Mais usuários a partir de dezembro',
      }),
    )
    expect(amended.revision).toBe(2)
    unwrap(
      await decide.suspend(commandOf(fixture.tenantId), contractId, {
        from: '2027-01-01',
        reason: 'Férias coletivas',
      }),
    )
    unwrap(await decide.resume(commandOf(fixture.tenantId), contractId, '2027-02-01'))
    const renewed = unwrap(
      await new RenewContractUseCase(unitOfWork, clock).execute({
        context: commandOf(fixture.tenantId),
        contractId,
        readjustmentBasisPoints: 500,
        reason: 'Reajuste anual acordado com o cliente',
      }),
    )
    expect(renewed).toMatchObject({ revision: 3, endsOn: '2028-09-30' })
    unwrap(
      await decide.cancel(commandOf(fixture.tenantId), contractId, {
        from: '2028-01-01',
        reason: 'Cliente encerrou a operação',
      }),
    )
    expect(unitOfWork.events.map((event) => event.eventType).slice(-5)).toEqual([
      'sales.contract.amended',
      'sales.contract.suspended',
      'sales.contract.suspended',
      'sales.contract.amended',
      'sales.contract.cancelled',
    ])
    expect(unitOfWork.auditRecords.map((record) => record.action)).toEqual(
      expect.arrayContaining([
        'contract.drafted',
        'contract.activate',
        'contract.amended',
        'contract.suspend',
        'contract.resume',
        'contract.renewed',
        'contract.cancel',
      ]),
    )
  })

  it('renews due contracts by itself once, and again only a term later', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const fixture = await seed(unitOfWork)
    const { contractId } = unwrap(
      await new CreateContractUseCase(unitOfWork, clock).execute({
        context: commandOf(fixture.tenantId),
        customerId: fixture.customerId,
        lines: [{ lineId: randomUUID(), itemId: fixture.service, quantity: '1' }],
        recurrence: 'quarterly',
        startsOn: '2026-07-01',
        endsOn: '2026-12-31',
        billingDay: 1,
        autoRenew: true,
      }),
    )
    unwrap(
      await new DecideContractUseCase(unitOfWork, clock).activate(
        commandOf(fixture.tenantId),
        contractId,
      ),
    )
    const renew = new RenewDueContractsUseCase(unitOfWork, clock)
    const context = { tenantId: fixture.tenantId, actor: 'user:operator', requestId: null }
    // The last quarter (October) has not begun on 20 September.
    expect((await renew.execute(context)).renewed).toEqual([])
    now = new Date('2026-10-02T12:00:00.000Z')
    expect((await renew.execute(context)).renewed).toEqual([contractId])
    expect((await renew.execute(context)).renewed).toEqual([])
    expect(
      snapshotOf(unitOfWork.contracts[0] as NonNullable<(typeof unitOfWork.contracts)[0]>).endsOn,
    ).toBe('2027-06-30')
  })
})
