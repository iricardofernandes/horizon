import { randomBytes, randomUUID } from 'node:crypto'
import { type EventEnvelope, findEvent } from '@horizon/contracts'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FinancialModuleEventHandlers } from '@/application/consume-module-events'
import {
  DecidePayableApprovalUseCase,
  DefineApprovalPolicyUseCase,
} from '@/application/use-cases/approve-payables'
import { DefineCategoryUseCase } from '@/application/use-cases/manage-dimensions'
import {
  DraftTitleUseCase,
  PostTitleUseCase,
  RecordSettlementUseCase,
} from '@/application/use-cases/manage-titles'
import type { TermsInput } from '@/application/use-cases/title-inputs'
import { FinancialDatabase } from '@/infrastructure/database/drizzle/financial-database'

const clock = { now: () => new Date() }
let database: FinancialDatabase
let administrator: ReturnType<typeof postgres>
let application: ReturnType<typeof postgres>

beforeAll(() => {
  database = new FinancialDatabase({ url: process.env.DATABASE_URL ?? '' })
  administrator = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
  application = postgres(process.env.DATABASE_URL ?? '', { max: 1 })
})

afterAll(async () => {
  await Promise.allSettled([database?.close(), administrator?.end(), application?.end()])
})

function value<T>(result: { isLeft(): boolean; value: unknown }): T {
  if (result.isLeft()) throw result.value
  return result.value as T
}

async function register(tenantId: string, roles: string[]) {
  const partyId = randomUUID()
  const envelope: EventEnvelope = {
    eventId: randomUUID(),
    tenantId,
    eventType: 'parties.party.registered',
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    traceId: randomBytes(16).toString('hex'),
    payload: {
      partyId,
      kind: 'organization',
      legalName: 'Fornecedora Papel Ltda',
      tradeName: null,
      email: 'contas@papel.example',
      phone: '+5511988887777',
      address: 'Rua Dois, 10, Campinas',
      roles,
    },
  }
  await new FinancialModuleEventHandlers(database, clock).handlers['parties.party.registered']?.(
    envelope,
  )
  return partyId
}

async function workspace() {
  const tenantId = randomUUID()
  const supplierId = await register(tenantId, ['supplier'])
  const categoryId = value<{ id: string }>(
    await new DefineCategoryUseCase(database, clock).execute({
      tenantId,
      code: '2.01',
      name: 'Office supplies',
      nature: 'expense',
    }),
  ).id
  const as = (actor: string) => ({ tenantId, actor, requestId: null })
  const keyed = (actor: string) => ({ ...as(actor), idempotencyKey: randomUUID() })
  const terms = (amount: string): TermsInput => ({
    partyId: supplierId,
    documentNumber: `NF-${amount}`,
    currency: 'BRL',
    categoryId,
    issuedOn: '2026-09-01',
    installments: [{ dueOn: '2026-09-30', amount }],
  })
  const draft = async (amount: string) =>
    value<{ id: string }>(
      await new DraftTitleUseCase(database, clock, 'payable').execute({
        context: keyed('clerk'),
        terms: terms(amount),
      }),
    ).id
  return { tenantId, supplierId, as, keyed, terms, draft }
}

const approvals = () => new DecidePayableApprovalUseCase(database, clock)
const post = () => new PostTitleUseCase(database, clock, 'payable')

describe('payables', () => {
  it('names only suppliers and expense categories', async () => {
    const { tenantId, keyed, terms } = await workspace()
    const customerId = await register(tenantId, ['customer'])
    const drafting = new DraftTitleUseCase(database, clock, 'payable')
    expect(
      (
        await drafting.execute({
          context: keyed('clerk'),
          terms: { ...terms('100'), partyId: customerId },
        })
      ).isLeft(),
    ).toBe(true)
    expect(await database.listCounterparties(tenantId, 'supplier')).toHaveLength(1)
  })

  it('posts only after a second person approves, and publishes the payable', async () => {
    const { tenantId, as, keyed, draft } = await workspace()
    const id = await draft('50000')

    expect((await post().execute({ context: keyed('clerk'), titleId: id })).isLeft()).toBe(true)
    value(await approvals().request(as('clerk'), id))
    expect((await database.titlesSummary(tenantId, 'payable', '2026-09-16')).awaitingApproval).toBe(
      1,
    )
    expect(
      (
        await database.listTitles(tenantId, 'payable', {
          view: 'awaiting-approval',
          today: '2026-09-16',
          limit: 50,
          offset: 0,
        })
      ).data.map((row) => row.id),
    ).toEqual([id])
    const selfApproval = await approvals().approve(as('clerk'), id)
    expect(selfApproval.isLeft() && selfApproval.value.message).toMatch(/cannot decide/)
    value(await approvals().approve(as('controller'), id))
    value(await post().execute({ context: keyed('clerk'), titleId: id }))

    const detail = await database.titleDetail(tenantId, 'payable', id, '2026-09-16')
    expect(detail).toMatchObject({
      status: 'posted',
      approvalState: 'approved',
      approvalRequestedBy: 'clerk',
      approvalDecidedBy: 'controller',
    })
    expect(detail?.timeline.map((entry) => entry.action)).toEqual([
      'payable.drafted',
      'payable.approval-requested',
      'payable.approved',
      'payable.posted',
    ])
    const [event] = await administrator<{ event_type: string; payload: unknown }[]>`
      select event_type, payload from outbox where tenant_id = ${tenantId}`
    expect(event?.event_type).toBe('financial.payable.posted')
    expect(
      findEvent('financial.payable.posted', 1)?.payload.safeParse(event?.payload).success,
    ).toBe(true)

    const paid = value<{ outstanding: string }>(
      await new RecordSettlementUseCase(database, clock, 'payable').execute({
        context: keyed('clerk'),
        titleId: id,
        settlement: { installmentNumber: 1, settledOn: '2026-09-20', received: '50000' },
      }),
    )
    expect(paid.outstanding).toBe('0')
  })

  it('lets a payable below the workspace threshold post without approval', async () => {
    const { as, keyed, draft, tenantId } = await workspace()
    value(
      await new DefineApprovalPolicyUseCase(database, clock).execute({
        context: as('controller'),
        currency: 'BRL',
        threshold: '100000',
      }),
    )
    const small = await draft('99999')
    const large = await draft('100000')
    value(await post().execute({ context: keyed('clerk'), titleId: small }))
    expect((await post().execute({ context: keyed('clerk'), titleId: large })).isLeft()).toBe(true)
    expect(
      (await database.titleDetail(tenantId, 'payable', small, '2026-09-16'))?.approvalState,
    ).toBe('not-required')
  })

  it('returns a rejected payable to draft with the reason in its history', async () => {
    const { as, keyed, draft, tenantId } = await workspace()
    const id = await draft('70000')
    value(await approvals().request(as('clerk'), id))
    value(await approvals().reject(as('controller'), id, 'Wrong supplier invoice'))
    expect((await post().execute({ context: keyed('clerk'), titleId: id })).isLeft()).toBe(true)
    expect(await database.titleDetail(tenantId, 'payable', id, '2026-09-16')).toMatchObject({
      status: 'draft',
      approvalState: 'rejected',
      approvalReason: 'Wrong supplier invoice',
    })
  })

  it('keeps the two directions apart', async () => {
    const { draft, keyed, as, tenantId } = await workspace()
    const id = await draft('100')
    expect(
      (
        await new PostTitleUseCase(database, clock, 'receivable').execute({
          context: keyed('clerk'),
          titleId: id,
        })
      ).isLeft(),
    ).toBe(true)
    expect(await database.titleDetail(tenantId, 'receivable', id, '2026-09-16')).toBeNull()
    expect((await approvals().request(as('clerk'), randomUUID())).isLeft()).toBe(true)
  })

  it('refuses in the database a posted payable nobody approved, or a self-approval', async () => {
    const { draft, tenantId } = await workspace()
    const id = await draft('100')
    const asTenant = (statement: (sql: postgres.TransactionSql) => Promise<unknown>) =>
      application.begin(async (sql) => {
        await sql`select set_config('app.current_tenant', ${tenantId}, true)`
        return statement(sql)
      })
    await expect(
      asTenant(
        (sql) => sql`update titles set status = 'posted', posted_at = now() where id = ${id}`,
      ),
    ).rejects.toThrow(/titles_posted_approval_check/)
    await expect(
      asTenant(
        (sql) =>
          sql`update titles set approval_state = 'approved', approval_requested_by = 'clerk',
            approval_decided_by = 'clerk' where id = ${id}`,
      ),
    ).rejects.toThrow(/titles_four_eyes_check/)
  })
})
