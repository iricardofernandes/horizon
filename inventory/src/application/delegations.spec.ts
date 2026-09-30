import { randomUUID } from 'node:crypto'
import { InMemoryInventoryUnitOfWork } from 'test/repositories/in-memory-inventory-unit-of-work'
import { beforeEach, describe, expect, it } from 'vitest'
import { left, right } from '@/core/either'
import {
  decideWith,
  GrantDelegationUseCase,
  ListDelegationsUseCase,
  onBehalfOf,
  RevokeDelegationUseCase,
  resolveAuthorities,
} from './use-cases/delegations'

const now = new Date('2026-09-30T12:00:00.000Z')
const clock = { now: () => now }
const APPROVE = 'inventory:adjustment:approve'
const APPROVER = 'user-approver'
const DELEGATE = 'user-delegate'

let unitOfWork: InMemoryInventoryUnitOfWork
let tenantId: string

const context = (actor: string, approvals: readonly string[] = []) => ({
  tenantId,
  actor,
  requestId: null,
  approvals,
})

const period = { startsAt: '2026-09-30T00:00:00.000Z', endsAt: '2026-10-07T00:00:00.000Z' }

async function lend(reason?: string) {
  const granted = await new GrantDelegationUseCase(unitOfWork, clock).execute({
    context: context(APPROVER, [APPROVE]),
    grant: { permission: APPROVE, delegateId: DELEGATE, ...period, reason },
  })
  if (granted.isLeft()) throw granted.value
  return granted.value
}

beforeEach(() => {
  unitOfWork = new InMemoryInventoryUnitOfWork()
  tenantId = randomUUID()
})

describe('lending an approval (ADR 0062)', () => {
  it('is recorded and audited, with the reason when there is one', async () => {
    const delegation = await lend('Férias')
    expect(delegation.delegateId).toBe(DELEGATE)
    expect(unitOfWork.auditRecords.at(-1)).toMatchObject({
      action: 'delegation.granted',
      details: { permission: APPROVE, delegateId: DELEGATE, reason: 'Férias' },
    })
    await lend()
    expect(unitOfWork.auditRecords.at(-1)?.details).not.toHaveProperty('reason')
  })

  it('is refused to someone who does not hold the approval through a role', async () => {
    const granted = await new GrantDelegationUseCase(unitOfWork, clock).execute({
      context: context(DELEGATE),
      grant: { permission: APPROVE, delegateId: 'someone-else', ...period },
    })
    expect(granted.isLeft() && granted.value.constructor.name).toBe('NotAllowedError')
  })

  it('is refused for a period that is not two instants, in order', async () => {
    const grant = new GrantDelegationUseCase(unitOfWork, clock)
    for (const dates of [
      { startsAt: 'not a date', endsAt: period.endsAt },
      { startsAt: period.startsAt, endsAt: 'not a date' },
      { startsAt: period.endsAt, endsAt: period.startsAt },
    ]) {
      const granted = await grant.execute({
        context: context(APPROVER, [APPROVE]),
        grant: { permission: APPROVE, delegateId: DELEGATE, ...dates },
      })
      expect(granted.isLeft()).toBe(true)
    }
    expect(unitOfWork.delegationRecords).toHaveLength(0)
  })
})

describe('ending a delegation early', () => {
  it('is for its delegator, or anyone holding the approval through a role', async () => {
    const revoke = new RevokeDelegationUseCase(unitOfWork, clock)
    const byDelegator = await revoke.execute({
      context: context(APPROVER),
      delegationId: (await lend()).id.toString(),
    })
    expect(byDelegator.isRight()).toBe(true)
    const byApprover = await revoke.execute({
      context: context('another-approver', [APPROVE]),
      delegationId: (await lend()).id.toString(),
    })
    expect(byApprover.isRight()).toBe(true)
    expect(unitOfWork.auditRecords.at(-1)?.action).toBe('delegation.revoked')
  })

  it('is refused to anyone else, for a delegation that does not exist, and twice', async () => {
    const revoke = new RevokeDelegationUseCase(unitOfWork, clock)
    const delegationId = (await lend()).id.toString()
    const byDelegate = await revoke.execute({ context: context(DELEGATE), delegationId })
    expect(byDelegate.isLeft() && byDelegate.value.constructor.name).toBe('NotAllowedError')
    const missing = await revoke.execute({
      context: context(APPROVER),
      delegationId: randomUUID(),
    })
    expect(missing.isLeft() && missing.value.constructor.name).toBe('ResourceNotFoundError')
    expect((await revoke.execute({ context: context(APPROVER), delegationId })).isRight()).toBe(
      true,
    )
    expect((await revoke.execute({ context: context(APPROVER), delegationId })).isLeft()).toBe(true)
  })
})

describe('listing delegations', () => {
  it('shows an approver every one, and anyone else only those naming them', async () => {
    await lend()
    const list = new ListDelegationsUseCase(unitOfWork)
    expect(await list.execute(context('another-approver', [APPROVE]))).toHaveLength(1)
    expect(await list.execute(context(DELEGATE))).toHaveLength(1)
    expect(await list.execute(context('a-stranger'))).toHaveLength(0)
  })
})

describe('who may decide', () => {
  it('is the person, through their role, or those who lent them the approval', async () => {
    await lend()
    const own = await unitOfWork.inTenant(tenantId, (scope) =>
      resolveAuthorities(scope, context(APPROVER, [APPROVE]), APPROVE, now),
    )
    expect(own.isRight() && own.value).toEqual([expect.objectContaining({ actor: APPROVER })])
    const lent = await unitOfWork.inTenant(tenantId, (scope) =>
      resolveAuthorities(scope, context(DELEGATE), APPROVE, now),
    )
    expect(lent.isRight() && lent.value.map(onBehalfOf)).toEqual([
      expect.objectContaining({ onBehalfOf: APPROVER }),
    ])
    const nobody = await unitOfWork.inTenant(tenantId, (scope) =>
      resolveAuthorities(scope, context('a-stranger'), APPROVE, now),
    )
    expect(nobody.isLeft()).toBe(true)
  })

  it('decides with the first authority accepted, or gives the first refusal', () => {
    const own = { actor: 'a', onBehalfOf: null, delegationId: null } as never
    const lent = { actor: 'a', onBehalfOf: 'b', delegationId: 'd' } as never
    expect(
      decideWith([own, lent], (authority) => (authority === lent ? right(undefined) : left('no')))
        .value,
    ).toBe(lent)
    expect(decideWith([own, lent], () => left('first')).value).toBe('first')
    expect(() => decideWith([], () => right(undefined))).toThrow()
    expect(onBehalfOf(own)).toEqual({})
  })
})
