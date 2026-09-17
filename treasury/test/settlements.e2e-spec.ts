import { randomBytes, randomUUID } from 'node:crypto'
import type { EventEnvelope } from '@horizon/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TreasuryModuleEventHandlers } from '@/application/consume-module-events'
import {
  ChangeAccountStatusUseCase,
  OpenAccountUseCase,
} from '@/application/use-cases/manage-accounts'
import { ReverseEntryUseCase } from '@/application/use-cases/manage-journal'
import { TreasuryDatabase } from '@/infrastructure/database/drizzle/treasury-database'

const clock = { now: () => new Date() }
let database: TreasuryDatabase
let handlers: TreasuryModuleEventHandlers

beforeAll(() => {
  database = new TreasuryDatabase({ url: process.env.DATABASE_URL ?? '' })
  handlers = new TreasuryModuleEventHandlers(database, clock)
})

afterAll(async () => {
  await database?.close()
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
  await handlers.handlers[eventType]?.(envelope)
}

async function workspace() {
  const tenantId = randomUUID()
  const context = () => ({
    tenantId,
    actor: 'user-1',
    requestId: null,
    idempotencyKey: randomUUID(),
  })
  const accountId = value<{ id: string }>(
    await new OpenAccountUseCase(database, clock).execute({
      context: context(),
      account: {
        kind: 'cash',
        name: 'Caixa',
        currency: 'BRL',
        openedOn: '2026-09-01',
        openingBalance: { amount: '0', direction: 'inflow' },
      },
    }),
  ).id
  const settlement = (overrides: Record<string, unknown> = {}) => ({
    settlementId: randomUUID(),
    titleId: randomUUID(),
    direction: 'receivable',
    partyId: randomUUID(),
    installmentNumber: 1,
    settledOn: '2026-09-15',
    received: { amount: '5000', currency: 'BRL' },
    discount: { amount: '0', currency: 'BRL' },
    interest: { amount: '0', currency: 'BRL' },
    penalty: { amount: '0', currency: 'BRL' },
    paymentMethodId: null,
    treasuryAccountId: accountId,
    outstanding: { amount: '0', currency: 'BRL' },
    recordedAt: '2026-09-15T12:00:00.000Z',
    ...overrides,
  })
  const statement = () =>
    database.accountStatement(tenantId, accountId, {
      from: '2026-09-01',
      to: '2026-09-30',
      limit: 50,
      offset: 0,
    })
  return { tenantId, accountId, context, settlement, statement }
}

describe('settlements reported by Financial', () => {
  it('become one journal entry in the named account, however often they arrive', async () => {
    const { tenantId, settlement, statement } = await workspace()
    const received = settlement()
    const eventId = randomUUID()
    await deliver(tenantId, 'financial.settlement.recorded', received, eventId)
    await deliver(tenantId, 'financial.settlement.recorded', received, eventId)
    await deliver(tenantId, 'financial.settlement.recorded', received)
    await deliver(
      tenantId,
      'financial.settlement.recorded',
      settlement({ direction: 'payable', received: { amount: '1200', currency: 'BRL' } }),
    )
    await deliver(
      tenantId,
      'financial.settlement.recorded',
      settlement({ treasuryAccountId: undefined }),
    )
    const { lines, closingBalance } = await statement()
    expect(lines.map((line) => [line.source, line.direction, line.amount])).toEqual([
      ['settlement', 'inflow', '5000'],
      ['settlement', 'outflow', '1200'],
    ])
    expect(closingBalance).toBe('3800')
  })

  it('is reversed when Financial reverses it, and never by hand', async () => {
    const { tenantId, context, settlement, statement } = await workspace()
    const received = settlement()
    await deliver(tenantId, 'financial.settlement.recorded', received)
    const [line] = (await statement()).lines
    expect(
      (
        await new ReverseEntryUseCase(database, clock).execute({
          context: context(),
          entryId: line?.id ?? '',
          reason: 'Should be reversed in Financial',
        })
      ).isLeft(),
    ).toBe(true)
    const reversal = {
      settlementId: received.settlementId,
      titleId: received.titleId,
      direction: 'receivable',
      partyId: received.partyId,
      reversedAt: '2026-09-16T12:00:00.000Z',
      reason: 'Payment bounced',
      outstanding: { amount: '5000', currency: 'BRL' },
    }
    await deliver(tenantId, 'financial.settlement.reversed', reversal)
    await deliver(tenantId, 'financial.settlement.reversed', reversal)
    const after = await statement()
    expect(after.lines.map((row) => [row.source, row.direction])).toEqual([
      ['settlement', 'inflow'],
      ['reversal', 'outflow'],
    ])
    expect(after.closingBalance).toBe('0')
  })

  it('records a refusal instead of failing when the account cannot take the entry', async () => {
    const { tenantId, accountId, settlement, statement } = await workspace()
    value(
      await new ChangeAccountStatusUseCase(database, clock).execute({
        context: { tenantId, actor: 'user-1', requestId: null },
        accountId,
        active: false,
      }),
    )
    const refused = settlement()
    await deliver(tenantId, 'financial.settlement.recorded', refused)
    await deliver(
      tenantId,
      'financial.settlement.recorded',
      settlement({ treasuryAccountId: randomUUID() }),
    )
    expect((await statement()).lines).toEqual([])
    const posting = await database.inTenant(tenantId, (scope) =>
      scope.settlements.find(refused.settlementId),
    )
    expect(posting).toMatchObject({ status: 'refused', reason: expect.stringMatching(/inactive/) })
  })
})
