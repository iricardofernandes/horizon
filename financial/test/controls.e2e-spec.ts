import { randomBytes, randomUUID } from 'node:crypto'
import type { EventEnvelope } from '@horizon/contracts'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FinancialModuleEventHandlers } from '@/application/consume-module-events'
import { DecidePayableApprovalUseCase } from '@/application/use-cases/approve-payables'
import {
  GrantDelegationUseCase,
  ListDelegationsUseCase,
  RevokeDelegationUseCase,
} from '@/application/use-cases/delegations'
import { DefineCategoryUseCase } from '@/application/use-cases/manage-dimensions'
import { DraftTitleUseCase } from '@/application/use-cases/manage-titles'
import { FinancialDatabase } from '@/infrastructure/database/drizzle/financial-database'

/**
 * Phase 68, over PostgreSQL: the payable pair of the segregation-of-duties matrix is refused,
 * a valid delegation lets someone else decide, and a tampered audit row reads as broken.
 */
const APPROVE = 'financial:payable:approve'
let clockNow = new Date()
const clock = { now: () => clockNow }
let database: FinancialDatabase
let owner: ReturnType<typeof postgres>

beforeAll(() => {
  database = new FinancialDatabase({ url: process.env.DATABASE_URL ?? '' })
  owner = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
})

afterAll(async () => {
  await Promise.allSettled([database?.close(), owner?.end()])
})

function value<T>(result: { isLeft(): boolean; value: unknown }): T {
  if (result.isLeft()) throw result.value
  return result.value as T
}

function refusal(result: { isLeft(): boolean; value: unknown }): { name: string; pair?: string } {
  if (!result.isLeft()) throw new Error('expected a refusal')
  return result.value as { name: string; pair?: string }
}

async function workspace() {
  const tenantId = randomUUID()
  const supplierId = randomUUID()
  const envelope: EventEnvelope = {
    eventId: randomUUID(),
    tenantId,
    eventType: 'parties.party.registered',
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    traceId: randomBytes(16).toString('hex'),
    payload: {
      partyId: supplierId,
      kind: 'organization',
      legalName: 'Fornecedora Papel Ltda',
      tradeName: null,
      email: 'contas@papel.example',
      phone: '+5511988887777',
      address: 'Rua Dois, 10, Campinas',
      roles: ['supplier'],
    },
  }
  await new FinancialModuleEventHandlers(database, clock).handlers['parties.party.registered']?.(
    envelope,
  )
  const categoryId = value<{ id: string }>(
    await new DefineCategoryUseCase(database, clock).execute({
      tenantId,
      code: '2.01',
      name: 'Office supplies',
      nature: 'expense',
    }),
  ).id
  /** A member of the module; `approver` holds the approval through a role. */
  const as = (actor: string, approver = false) => ({
    tenantId,
    actor,
    requestId: null,
    approvals: approver ? [APPROVE] : [],
  })
  const pending = async (drafter: string, requester = drafter) => {
    const id = value<{ id: string }>(
      await new DraftTitleUseCase(database, clock, 'payable').execute({
        context: { ...as(drafter), idempotencyKey: randomUUID() },
        terms: {
          partyId: supplierId,
          documentNumber: `NF-${randomBytes(3).toString('hex')}`,
          currency: 'BRL',
          categoryId,
          issuedOn: '2026-09-01',
          installments: [{ dueOn: '2026-09-30', amount: '90000' }],
        },
      }),
    ).id
    value(await decisions().request(as(requester), id))
    return id
  }
  const lend = (from: string, to: string, days = 7, startsInDays = 0) =>
    new GrantDelegationUseCase(database, clock).execute({
      context: as(from, true),
      grant: {
        permission: APPROVE,
        delegateId: to,
        startsAt: new Date(clockNow.getTime() + startsInDays * 86_400_000).toISOString(),
        endsAt: new Date(clockNow.getTime() + days * 86_400_000).toISOString(),
        reason: 'Holiday',
      },
    })
  return { tenantId, as, pending, lend }
}

const decisions = () => new DecidePayableApprovalUseCase(database, clock)

describe('the financial.payable pair', () => {
  it('is refused to whoever drafted or asked, even holding the approval', async () => {
    clockNow = new Date()
    const { as, pending } = await workspace()
    const byDrafter = await pending('drafter', 'clerk')
    expect(refusal(await decisions().approve(as('drafter', true), byDrafter))).toMatchObject({
      name: 'SegregationOfDutiesError',
      pair: 'financial.payable',
    })
    expect(refusal(await decisions().approve(as('clerk', true), byDrafter)).pair).toBe(
      'financial.payable',
    )
    value(await decisions().approve(as('controller', true), byDrafter))
  })

  it('is allowed through a valid delegation to someone else, recording both names', async () => {
    clockNow = new Date()
    const { tenantId, as, pending, lend } = await workspace()
    const id = await pending('clerk')
    expect(refusal(await decisions().approve(as('stand-in'), id)).name).toBe('NotAllowedError')
    const delegation = value<{ id: { toString(): string } }>(await lend('controller', 'stand-in'))
    value(await decisions().approve(as('stand-in'), id))
    const detail = await database.titleDetail(tenantId, 'payable', id, '2026-09-28')
    expect(detail).toMatchObject({ approvalState: 'approved' })
    const [row] = await owner`select approval_decided_by, approval_decided_for from titles
      where id = ${id}`
    expect(row).toEqual({ approval_decided_by: 'stand-in', approval_decided_for: 'controller' })
    const page = await database.auditPage(tenantId, { action: 'payable.approved', limit: 10 })
    expect(page.data[0]).toMatchObject({
      actor: 'stand-in',
      details: { onBehalfOf: 'controller', delegationId: delegation.id.toString() },
    })
  })

  it('never lets a delegate decide their own work, or work of whoever lent it', async () => {
    clockNow = new Date()
    const { tenantId, as, pending, lend } = await workspace()
    value(await lend('controller', 'stand-in'))
    const own = await pending('stand-in')
    expect(refusal(await decisions().approve(as('stand-in'), own)).pair).toBe('financial.payable')

    const byLender = await pending('lender')
    value(await lend('lender', 'helper'))
    expect(refusal(await decisions().reject(as('helper'), byLender, 'Not ours')).pair).toBe(
      'financial.payable',
    )
    // Lent the same approval by someone else too, the helper decides for that person.
    value(await lend('controller', 'helper'))
    value(await decisions().approve(as('helper'), byLender))
    const [row] = await owner`select approval_decided_for from titles where id = ${byLender}`
    expect(row?.approval_decided_for).toBe('controller')
    expect(tenantId).toBeTruthy()
  })

  it('stops working when revoked or ended, and cannot be passed on', async () => {
    clockNow = new Date()
    const { as, pending, lend } = await workspace()
    const delegation = value<{ id: { toString(): string } }>(await lend('controller', 'stand-in'))
    expect(
      refusal(
        await new GrantDelegationUseCase(database, clock).execute({
          context: as('stand-in'),
          grant: {
            permission: APPROVE,
            delegateId: 'third',
            startsAt: clockNow.toISOString(),
            endsAt: new Date(clockNow.getTime() + 86_400_000).toISOString(),
          },
        }),
      ).name,
    ).toBe('NotAllowedError')
    expect(
      refusal(
        await new RevokeDelegationUseCase(database, clock).execute({
          context: as('someone'),
          delegationId: delegation.id.toString(),
        }),
      ).name,
    ).toBe('NotAllowedError')
    value(
      await new RevokeDelegationUseCase(database, clock).execute({
        context: as('controller'),
        delegationId: delegation.id.toString(),
      }),
    )
    const first = await pending('clerk')
    expect(refusal(await decisions().approve(as('stand-in'), first)).name).toBe('NotAllowedError')

    value(await lend('controller', 'stand-in', 2))
    clockNow = new Date(Date.now() + 3 * 86_400_000)
    expect(refusal(await decisions().approve(as('stand-in'), first)).name).toBe('NotAllowedError')
    const listed = await new ListDelegationsUseCase(database).execute(as('stand-in'))
    expect(listed.map((entry) => entry.stateAt(clockNow)).sort()).toEqual(['ended', 'revoked'])
  })
})

describe('the audit read endpoint', () => {
  it('filters a page, and shows a tampered row as a broken chain', async () => {
    clockNow = new Date()
    const { tenantId, pending } = await workspace()
    await pending('clerk')
    const intact = await database.auditPage(tenantId, { limit: 50 })
    expect(intact.chain).toEqual({ status: 'intact', checked: intact.data.length, broken: [] })
    expect(intact.data.map((entry) => entry.action)).toEqual([
      'payable.approval-requested',
      'payable.drafted',
    ])
    const onePage = await database.auditPage(tenantId, { limit: 1 })
    expect(onePage.page).toEqual({ nextCursor: String(onePage.data[0]?.sequence), hasMore: true })
    const second = await database.auditPage(tenantId, {
      limit: 1,
      before: onePage.data[0]?.sequence,
    })
    expect(second.data.map((entry) => entry.action)).toEqual(['payable.drafted'])
    expect((await database.auditPage(tenantId, { actor: 'nobody', limit: 10 })).data).toHaveLength(
      0,
    )

    await owner.begin(async (tx) => {
      await tx`set local session_replication_role = replica`
      await tx`update audit_log set details = ${tx.json({ total: '1' })}
        where tenant_id = ${tenantId} and action = 'payable.drafted'`
    })
    const tampered = await database.auditPage(tenantId, { limit: 50 })
    expect(tampered.chain.status).toBe('broken')
    expect(tampered.chain.broken).toEqual([1])
    // A filter that leaves the tampered row out still sees its successor's link break.
    // A filter that leaves the changed row out does not judge it; re-hashing the row to
    // hide the change breaks its successor's link, which does show.
    await owner.begin(async (tx) => {
      await tx`set local session_replication_role = replica`
      await tx`update audit_log set hash = ${'f'.repeat(64)}
        where tenant_id = ${tenantId} and action = 'payable.drafted'`
    })
    const filtered = await database.auditPage(tenantId, {
      action: 'payable.approval-requested',
      limit: 50,
    })
    expect(filtered.chain).toMatchObject({ status: 'broken', broken: [2] })
  })
})
