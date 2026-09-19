import { randomUUID } from 'node:crypto'
import { InMemorySalesUnitOfWork } from 'test/repositories/in-memory-sales-unit-of-work'
import { snapshotOf } from 'test/support/snapshot-of'
import { Currency, LineDescription, Money } from '@/domain/value-objects/sales-values'
import { DecideQuoteUseCase, WriteQuoteUseCase } from './use-cases/manage-quotes'
import {
  ForgetPartyUseCase,
  type PartyState,
  ProjectPartyUseCase,
} from './use-cases/project-parties'

function unwrap<T>(result: { isLeft(): boolean; value: T }): T {
  if (result.isLeft()) throw result.value
  return result.value
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing test fixture')
  return value
}

const now = new Date('2026-09-14T20:00:00.000Z')
const clock = { now: () => now }

function partyState(tenantId: string, overrides: Partial<PartyState> = {}): PartyState {
  return {
    tenantId,
    partyId: randomUUID(),
    legalName: '  Maria   Silva ',
    email: ' MARIA@EXAMPLE.COM ',
    phone: '+55 (11) 99999-9999',
    address: 'Rua Um, 42, São Paulo',
    roles: ['customer'],
    active: true,
    ...overrides,
  }
}

async function project(unitOfWork: InMemorySalesUnitOfWork, state: PartyState) {
  return unitOfWork.inTenant(state.tenantId, (scope) =>
    new ProjectPartyUseCase(clock).executeInScope(scope, state),
  )
}

async function customerFixture(unitOfWork: InMemorySalesUnitOfWork) {
  const state = partyState(randomUUID())
  unwrap(await project(unitOfWork, state))
  return { tenantId: state.tenantId, customerId: state.partyId }
}

/** Every committing command names who ran it and carries a key it can be retried under. */
function commandOf(tenantId: string, actor = 'ana') {
  return { tenantId, actor, requestId: null, idempotencyKey: randomUUID() }
}

/** The arguments a quote is written under, with a fresh key for each attempt. */
function writing(fixture: { tenantId: string; customerId: string }) {
  return { context: commandOf(fixture.tenantId), customerId: fixture.customerId }
}

describe('customers and quotes', () => {
  it('projects a party holding the customer role under the party id', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const fixture = await customerFixture(unitOfWork)
    expect(snapshotOf(required(unitOfWork.customers[0]))).toMatchObject({
      id: fixture.customerId,
      name: 'Maria Silva',
      taxId: null,
      email: 'maria@example.com',
      phone: '+5511999999999',
      status: 'active',
    })
  })

  it('ignores a party that has never been a customer', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const outcome = await project(unitOfWork, partyState(randomUUID(), { roles: ['supplier'] }))
    expect(unwrap(outcome)).toBe('ignored')
    expect(unitOfWork.customers).toHaveLength(0)
  })

  it('keeps a former customer projected, but closed to new quotes', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const state = partyState(randomUUID())
    unwrap(await project(unitOfWork, state))
    expect(unwrap(await project(unitOfWork, { ...state, roles: ['supplier'] }))).toBe('refreshed')
    expect(snapshotOf(required(unitOfWork.customers[0])).status).toBe('inactive')
    const quote = await new WriteQuoteUseCase(unitOfWork, clock, 15).execute({
      context: commandOf(state.tenantId),
      customerId: state.partyId,
      quote: { lines: [{ lineId: randomUUID(), itemId: randomUUID(), quantity: '1' }] },
    })
    expect(quote.isLeft()).toBe(true)
  })

  it('snapshots current catalog prices into an expiring quote and accepts it once', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const fixture = await customerFixture(unitOfWork)
    const itemId = randomUUID()
    const currency = unwrap(Currency.create('BRL'))
    unitOfWork.catalogItems.push({
      tenantId: fixture.tenantId,
      itemId,
      description: unwrap(LineDescription.create('Coffee')),
      unitPrice: unwrap(Money.create('1250', currency)),
      active: true,
    })
    const created = await new WriteQuoteUseCase(unitOfWork, clock, 15).execute({
      ...writing(fixture),
      quote: { lines: [{ lineId: randomUUID(), itemId, quantity: '2.5' }] },
    })
    if (created.isLeft()) throw created.value
    expect(created.value.expiresAt).toEqual(new Date('2026-09-29T20:00:00.000Z'))
    expect(snapshotOf(required(unitOfWork.quotes[0]))).toMatchObject({
      customerId: fixture.customerId,
      status: 'draft',
      currency: 'BRL',
      net: '3125',
      total: '3125',
      lines: [{ itemId, quantity: '2.5', unitPrice: '1250', lineTotal: '3125' }],
    })
    // Only an offer the customer was actually shown can be accepted.
    const decide = new DecideQuoteUseCase(unitOfWork, clock)
    expect((await decide.accept(commandOf(fixture.tenantId), created.value.quoteId)).isLeft()).toBe(
      true,
    )
    expect((await decide.send(commandOf(fixture.tenantId), created.value.quoteId)).isRight()).toBe(
      true,
    )
    expect(
      (await decide.accept(commandOf(fixture.tenantId), created.value.quoteId)).isRight(),
    ).toBe(true)
    expect((await decide.accept(commandOf(fixture.tenantId), created.value.quoteId)).isLeft()).toBe(
      true,
    )
  })

  it('forgets an erased party and never brings it back', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const state = partyState(randomUUID())
    unwrap(await project(unitOfWork, state))
    const forgotten = await unitOfWork.inTenant(state.tenantId, (scope) =>
      new ForgetPartyUseCase(clock).executeInScope(scope, state.partyId),
    )
    expect(forgotten).toBe(true)
    expect(snapshotOf(required(unitOfWork.customers[0]))).toMatchObject({ status: 'erased' })
    expect(unwrap(await project(unitOfWork, state))).toBe('ignored')
    const quote = await new WriteQuoteUseCase(unitOfWork, clock, 15).execute({
      context: commandOf(state.tenantId),
      customerId: state.partyId,
      quote: { lines: [{ lineId: randomUUID(), itemId: randomUUID(), quantity: '1' }] },
    })
    expect(quote.isLeft()).toBe(true)
  })

  it('refuses a party whose details Sales cannot print', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    expect((await project(unitOfWork, partyState(randomUUID(), { legalName: '' }))).isLeft()).toBe(
      true,
    )
    expect(
      (await project(unitOfWork, partyState(randomUUID(), { email: 'invalid' }))).isLeft(),
    ).toBe(true)
    expect((await project(unitOfWork, partyState(randomUUID(), { phone: '12' }))).isLeft()).toBe(
      true,
    )
  })

  it('rejects malformed quote lines, inactive items and mixed currencies', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const fixture = await customerFixture(unitOfWork)
    expect(() => new WriteQuoteUseCase(unitOfWork, clock, 0)).toThrow()
    const create = new WriteQuoteUseCase(unitOfWork, clock, 1)
    expect((await create.execute({ ...writing(fixture), quote: { lines: [] } })).isLeft()).toBe(
      true,
    )
    expect(
      (
        await create.execute({
          ...writing(fixture),
          quote: { lines: [{ lineId: randomUUID(), itemId: randomUUID(), quantity: '-1' }] },
        })
      ).isLeft(),
    ).toBe(true)
    expect(
      (
        await create.execute({
          ...writing(fixture),
          quote: { lines: [{ lineId: randomUUID(), itemId: randomUUID(), quantity: '0' }] },
        })
      ).isLeft(),
    ).toBe(true)
    const inactiveId = randomUUID()
    const brl = unwrap(Currency.create('BRL'))
    unitOfWork.catalogItems.push({
      tenantId: fixture.tenantId,
      itemId: inactiveId,
      description: unwrap(LineDescription.create('Inactive')),
      unitPrice: unwrap(Money.create('100', brl)),
      active: false,
    })
    expect(
      (
        await create.execute({
          ...writing(fixture),
          quote: { lines: [{ lineId: randomUUID(), itemId: inactiveId, quantity: '1' }] },
        })
      ).isLeft(),
    ).toBe(true)

    const firstId = randomUUID()
    const secondId = randomUUID()
    unitOfWork.catalogItems.push(
      {
        tenantId: fixture.tenantId,
        itemId: firstId,
        description: unwrap(LineDescription.create('BRL item')),
        unitPrice: unwrap(Money.create('100', brl)),
        active: true,
      },
      {
        tenantId: fixture.tenantId,
        itemId: secondId,
        description: unwrap(LineDescription.create('USD item')),
        unitPrice: unwrap(Money.create('100', unwrap(Currency.create('USD')))),
        active: true,
      },
    )
    expect(
      (
        await create.execute({
          ...writing(fixture),
          quote: {
            lines: [
              { lineId: randomUUID(), itemId: firstId, quantity: '1' },
              { lineId: randomUUID(), itemId: secondId, quantity: '1' },
            ],
          },
        })
      ).isLeft(),
    ).toBe(true)
  })

  it('persists the expired state when acceptance arrives after validity', async () => {
    const unitOfWork = new InMemorySalesUnitOfWork()
    const fixture = await customerFixture(unitOfWork)
    const itemId = randomUUID()
    const currency = unwrap(Currency.create('BRL'))
    unitOfWork.catalogItems.push({
      tenantId: fixture.tenantId,
      itemId,
      description: unwrap(LineDescription.create('Coffee')),
      unitPrice: unwrap(Money.create('100', currency)),
      active: true,
    })
    const created = await new WriteQuoteUseCase(unitOfWork, clock, 1).execute({
      ...writing(fixture),
      quote: { lines: [{ lineId: randomUUID(), itemId, quantity: '1' }] },
    })
    if (created.isLeft()) throw created.value
    // The offer goes out while it is still good, and the answer arrives too late.
    expect(
      (
        await new DecideQuoteUseCase(unitOfWork, clock).send(
          commandOf(fixture.tenantId),
          created.value.quoteId,
        )
      ).isRight(),
    ).toBe(true)
    const lateClock = { now: () => new Date(now.getTime() + 2 * 86_400_000) }
    const accepted = await new DecideQuoteUseCase(unitOfWork, lateClock).accept(
      commandOf(fixture.tenantId),
      created.value.quoteId,
    )
    expect(accepted.isLeft()).toBe(true)
    // The state it was found in is kept, so a list reads as it is rather than as it was.
    expect(snapshotOf(required(unitOfWork.quotes[0])).status).toBe('expired')
  })
})
