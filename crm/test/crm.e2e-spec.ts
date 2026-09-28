import { randomBytes, randomUUID } from 'node:crypto'
import type { EventEnvelope } from '@horizon/contracts'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CrmModuleEventHandlers } from '@/application/consume-module-events'
import { UpdateAccountProfileUseCase } from '@/application/use-cases/manage-accounts'
import { CreateContactUseCase, EraseContactUseCase } from '@/application/use-cases/manage-contacts'
import {
  ChangeOpportunityUseCase,
  CreateOpportunityUseCase,
} from '@/application/use-cases/manage-opportunities'
import {
  ChangePipelineUseCase,
  CreateListEntryUseCase,
  CreatePipelineUseCase,
} from '@/application/use-cases/manage-pipelines'
import type { Either } from '@/core/either'
import { foldHistory } from '@/domain/entities/opportunity'
import { AesGcmSecretBox } from '@/infrastructure/cryptography/aes-gcm-secret-box'
import { CrmDatabase } from '@/infrastructure/database/drizzle/crm-database'
import { auditHash } from '@/infrastructure/database/drizzle/crm-store'

const clock = { now: () => new Date() }
let database: CrmDatabase
let handlers: CrmModuleEventHandlers
let application: ReturnType<typeof postgres>
/** The superuser: reads what RLS hides from the application and tries what triggers forbid. */
let administrator: ReturnType<typeof postgres>

beforeAll(() => {
  database = new CrmDatabase({
    url: process.env.DATABASE_URL ?? '',
    secretBox: new AesGcmSecretBox(),
  })
  handlers = new CrmModuleEventHandlers(database, clock)
  application = postgres(process.env.DATABASE_URL ?? '', { max: 1 })
  administrator = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
})

afterAll(async () => {
  await Promise.allSettled([database?.close(), application?.end(), administrator?.end()])
})

function valid<L, R>(result: Either<L, R>): R {
  if (result.isLeft()) throw result.value
  return result.value
}

async function deliver(tenantId: string, eventType: string, payload: object, eventVersion = 2) {
  const event: EventEnvelope = {
    eventId: randomUUID(),
    eventType,
    eventVersion,
    occurredAt: new Date().toISOString(),
    tenantId,
    traceId: randomBytes(16).toString('hex'),
    payload,
  }
  const handler = handlers.handlers[eventType]
  if (!handler) throw new Error(`no handler for ${eventType}`)
  await handler(event)
  return event
}

/** A workspace with one prospect account and one contact at it. */
async function workspace() {
  const tenantId = randomUUID()
  const partyId = randomUUID()
  await deliver(tenantId, 'parties.party.registered', {
    partyId,
    kind: 'organization',
    legalName: 'Acme GmbH',
    tradeName: null,
    email: null,
    phone: null,
    address: null,
    documentType: 'foreign',
    documentCountry: 'DE',
    roles: ['prospect'],
  })
  const { contactId } = valid(
    await new CreateContactUseCase(database, clock).execute({
      context: { tenantId, actor: 'ana', requestId: null, idempotencyKey: randomUUID() },
      accountId: partyId,
      contact: {
        name: 'João Lima',
        jobTitle: 'Comprador',
        email: 'joao@acme.example',
        phone: '+49 30 1234 5678',
        lawfulBasis: 'legitimate-interest',
      },
    }),
  )
  return { tenantId, partyId, contactId }
}

describe('accounts and contacts on PostgreSQL', () => {
  it('stores contact data only as ciphertext and reads it back through its own key', async () => {
    const { tenantId, partyId, contactId } = await workspace()
    const [row] = await administrator`select * from contacts where id = ${contactId}`
    expect(JSON.stringify(row)).not.toMatch(/João|joao@acme|Comprador|1234/)
    const detail = await database.accountDetail(tenantId, partyId)
    expect(detail?.account).toMatchObject({ legalName: 'Acme GmbH', documentType: 'foreign' })
    expect(detail?.contacts).toEqual([
      expect.objectContaining({
        id: contactId,
        name: 'João Lima',
        email: 'joao@acme.example',
        phone: '+493012345678',
        status: 'active',
      }),
    ])
  })

  it('erases a contact by destroying its key, and never lets the key come back', async () => {
    const { tenantId, partyId, contactId } = await workspace()
    valid(
      await new EraseContactUseCase(database, clock).execute({
        context: { tenantId, actor: 'ana', requestId: null },
        contactId,
      }),
    )
    const [key] =
      await administrator`select material, erased_at from contact_data_keys where id = ${contactId}`
    expect(key?.material).toBeNull()
    expect(key?.erased_at).not.toBeNull()
    expect(await database.contactDetail(tenantId, contactId)).toMatchObject({
      name: null,
      email: null,
      status: 'erased',
    })
    expect((await database.accountDetail(tenantId, partyId))?.account.status).toBe('active')
    await expect(
      administrator`update contact_data_keys set material = 'back', erased_at = null where id = ${contactId}`,
    ).rejects.toThrow(/cannot be restored/)
  })

  it('shreds every contact of an erased party and blanks the account', async () => {
    const { tenantId, partyId, contactId } = await workspace()
    await deliver(tenantId, 'parties.party.erased', { partyId }, 1)
    const [key] =
      await administrator`select material from contact_data_keys where id = ${contactId}`
    expect(key?.material).toBeNull()
    const [account] =
      await administrator`select legal_name, trade_name, status from accounts where id = ${partyId}`
    expect(account).toEqual({ legal_name: '', trade_name: null, status: 'erased' })
  })

  it('creates a contact once per idempotency key', async () => {
    const { tenantId, partyId } = await workspace()
    const create = new CreateContactUseCase(database, clock)
    const context = { tenantId, actor: 'ana', requestId: null, idempotencyKey: randomUUID() }
    const contact = { name: 'Maria', lawfulBasis: 'consent' }
    const [first, second] = await Promise.all([
      create.execute({ context, accountId: partyId, contact }),
      create.execute({ context, accountId: partyId, contact }),
    ])
    expect(valid(first)).toEqual(valid(second))
    const reused = await create.execute({
      context,
      accountId: partyId,
      contact: { ...contact, name: 'Outra' },
    })
    expect(reused.isLeft() && reused.value.message).toMatch(/different request/)
  })

  it('applies a redelivered event once', async () => {
    const tenantId = randomUUID()
    const event = await deliver(
      tenantId,
      'identity.user.registered',
      {
        tenantId,
        userId: randomUUID(),
        registeredAt: new Date().toISOString(),
      },
      1,
    )
    await handlers.handlers[event.eventType]?.(event)
    const [inbox] =
      await administrator`select count(*)::int as n from inbox where event_id = ${event.eventId}`
    expect(inbox?.n).toBe(1)
    expect(await database.listOwners(tenantId)).toHaveLength(1)
  })

  it('chains the audit log and refuses to rewrite it', async () => {
    const { tenantId, partyId } = await workspace()
    const ownerId = randomUUID()
    await deliver(
      tenantId,
      'identity.user.registered',
      { tenantId, userId: ownerId, registeredAt: new Date().toISOString() },
      1,
    )
    valid(
      await new UpdateAccountProfileUseCase(database, clock).execute({
        context: { tenantId, actor: 'ana', requestId: 'req-1' },
        accountId: partyId,
        profile: { ownerId, tags: ['vip'] },
      }),
    )
    const entries =
      await administrator`select * from audit_log where tenant_id = ${tenantId} order by sequence`
    expect(entries.map((entry) => entry.action)).toEqual([
      'contact.created',
      'account.profile-changed',
    ])
    const [first, second] = entries
    expect(second?.previous_hash).toBe(first?.hash)
    expect(JSON.stringify(entries)).not.toContain('João')
    expect(
      auditHash(String(second?.previous_hash), {
        sequence: Number(second?.sequence),
        tenantId,
        actor: second?.actor,
        subjectType: second?.subject_type,
        subjectId: second?.subject_id,
        action: second?.action,
        occurredAt: second?.occurred_at,
        requestId: second?.request_id,
        traceId: second?.trace_id,
        details: second?.details,
      }),
    ).toBe(second?.hash)
    await expect(
      administrator`update audit_log set actor = 'x' where tenant_id = ${tenantId}`,
    ).rejects.toThrow(/append-only/)
    // Phase 68: the audit read endpoint judges each page, and a tampered row shows.
    expect((await database.auditPage(tenantId, { limit: 50 })).chain.status).toBe('intact')
    await administrator.begin(async (tx) => {
      await tx`set local session_replication_role = replica`
      await tx`update audit_log set actor = 'someone else' where tenant_id = ${tenantId} and sequence = 1`
    })
    expect((await database.auditPage(tenantId, { limit: 50 })).chain).toMatchObject({
      status: 'broken',
      broken: [1],
    })
  })

  it('never shows one tenant another tenant’s rows, in any table', async () => {
    const { tenantId } = await workspace()
    await deliver(
      tenantId,
      'identity.user.registered',
      { tenantId, userId: randomUUID(), registeredAt: new Date().toISOString() },
      1,
    )
    const intruder = randomUUID()
    const tables = [
      'accounts',
      'contacts',
      'contact_data_keys',
      'owners',
      'audit_log',
      'command_receipts',
      'inbox',
    ]
    for (const table of tables) {
      const [owned] =
        await administrator`select count(*)::int as n from ${administrator(table)} where tenant_id = ${tenantId}`
      expect(owned?.n, table).toBeGreaterThan(0)
      const visible = await application.begin(async (tx) => {
        await tx`select set_config('app.current_tenant', ${intruder}, true)`
        return tx`select count(*)::int as n from ${tx(table)}`
      })
      expect(visible[0]?.n, table).toBe(0)
    }
    // The application writes the outbox and never reads it; only the relay does.
    await expect(
      application.begin(async (tx) => {
        await tx`select set_config('app.current_tenant', ${tenantId}, true)`
        return tx`select count(*) from outbox`
      }),
    ).rejects.toThrow(/permission denied/)
    expect(
      await database.listAccounts(intruder, {
        search: null,
        role: null,
        ownerId: null,
        status: null,
        limit: 50,
        offset: 0,
      }),
    ).toEqual({ data: [], total: 0 })
  })

  it('filters accounts by search, role, owner and status', async () => {
    const { tenantId } = await workspace()
    await deliver(tenantId, 'parties.party.registered', {
      partyId: randomUUID(),
      kind: 'person',
      legalName: 'Maria 100% Souza',
      tradeName: null,
      email: 'm@example.com',
      phone: '+5511999990000',
      address: 'Rua Um, 1',
      documentType: 'none',
      documentCountry: null,
      roles: ['customer'],
    })
    const list = (filter: Partial<Parameters<CrmDatabase['listAccounts']>[1]>) =>
      database.listAccounts(tenantId, {
        search: null,
        role: null,
        ownerId: null,
        status: null,
        limit: 50,
        offset: 0,
        ...filter,
      })
    expect((await list({})).total).toBe(2)
    expect((await list({ search: 'acme' })).data.map((row) => row.legalName)).toEqual(['Acme GmbH'])
    expect((await list({ search: '100%' })).data.map((row) => row.legalName)).toEqual([
      'Maria 100% Souza',
    ])
    expect((await list({ role: 'customer' })).total).toBe(1)
    expect((await list({ status: 'erased' })).total).toBe(0)
    expect((await list({ ownerId: randomUUID() })).total).toBe(0)
  })
})

describe('pipelines and opportunities on PostgreSQL', () => {
  async function sales() {
    const { tenantId, partyId, contactId } = await workspace()
    const ownerId = randomUUID()
    await deliver(
      tenantId,
      'identity.user.registered',
      { tenantId, userId: ownerId, registeredAt: new Date().toISOString() },
      1,
    )
    const keyed = () => ({ tenantId, actor: 'ana', requestId: null, idempotencyKey: randomUUID() })
    const { pipelineId } = valid(
      await new CreatePipelineUseCase(database, clock).execute({
        context: keyed(),
        name: 'Vendas',
        stages: [
          { name: 'Qualificação', probabilityBps: 1000 },
          { name: 'Proposta', probabilityBps: 5000 },
          { name: 'Negociação', probabilityBps: 8000 },
        ],
      }),
    )
    const stages =
      (await database.pipelineDetail(tenantId, pipelineId))?.stages.map((stage) => stage.id) ?? []
    const lists = new CreateListEntryUseCase(database, clock)
    const { entryId: sourceId } = valid(
      await lists.execute({ context: keyed(), kind: 'source', name: 'Indicação' }),
    )
    const { entryId: reasonId } = valid(
      await lists.execute({ context: keyed(), kind: 'loss-reason', name: 'Preço' }),
    )
    const request = {
      accountId: partyId,
      ownerId,
      pipelineId,
      stageId: stages[0] as string,
      terms: {
        title: 'Renovação Acme 2027',
        contactIds: [contactId],
        sourceId,
        expectedValue: { amount: '1500000', currency: 'BRL' },
        expectedCloseOn: '2026-12-15',
      },
    }
    const { opportunityId } = valid(
      await new CreateOpportunityUseCase(database, clock).execute({ ...request, context: keyed() }),
    )
    return {
      tenantId,
      partyId,
      ownerId,
      pipelineId,
      stages,
      sourceId,
      reasonId,
      opportunityId,
      request,
      keyed,
    }
  }

  it('rebuilds an opportunity from its stored history, which cannot be rewritten', async () => {
    const world = await sales()
    const change = new ChangeOpportunityUseCase(database, clock)
    const request = {
      context: { tenantId: world.tenantId, actor: 'ana', requestId: null },
      opportunityId: world.opportunityId,
    }
    valid(await change.move({ ...request, stageId: world.stages[1] as string }))
    valid(await change.lose({ ...request, lossReasonId: world.reasonId, note: 'Caro' }))
    valid(await change.reopen({ ...request, stageId: world.stages[2] as string }))
    valid(await change.lose({ ...request, lossReasonId: world.reasonId }))
    const detail = await database.opportunityDetail(world.tenantId, world.opportunityId)
    if (!detail) throw new Error('missing opportunity')
    expect(detail.history.map((recorded) => recorded.fact.type)).toEqual([
      'created',
      'stage-changed',
      'lost',
      'reopened',
      'lost',
    ])
    const { id: _, tenantId: __, ...state } = detail.opportunity
    expect(foldHistory(detail.history)).toEqual(state)
    expect(state).toMatchObject({
      status: 'lost',
      lossReasonId: world.reasonId,
      lossNote: null,
      version: 5,
    })
    await expect(
      administrator`update opportunity_events set actor = 'x' where opportunity_id = ${world.opportunityId}`,
    ).rejects.toThrow(/append-only/)
    await expect(
      administrator`delete from opportunity_events where opportunity_id = ${world.opportunityId}`,
    ).rejects.toThrow(/append-only/)
  })

  it('publishes each fact to the outbox without the title or the contacts', async () => {
    const world = await sales()
    const change = new ChangeOpportunityUseCase(database, clock)
    valid(
      await change.win({
        context: { tenantId: world.tenantId, actor: 'ana', requestId: null },
        opportunityId: world.opportunityId,
      }),
    )
    const events = await administrator`select event_type, payload from outbox
      where tenant_id = ${world.tenantId} and event_type like 'crm.opportunity.%' order by created_at`
    expect(events.map((event) => event.event_type)).toEqual([
      'crm.opportunity.created',
      'crm.opportunity.won',
    ])
    expect(events[1]?.payload).toMatchObject({
      value: { amount: '1500000', currency: 'BRL' },
      sourceId: world.sourceId,
    })
    expect(JSON.stringify(events)).not.toMatch(/Renovação|contactIds/)
  })

  it('keeps opportunities on an archived stage, and reorders stages in one transaction', async () => {
    const world = await sales()
    const change = new ChangePipelineUseCase(database, clock)
    const context = { tenantId: world.tenantId, actor: 'ana', requestId: null }
    valid(
      await change.execute({
        context,
        pipelineId: world.pipelineId,
        change: { kind: 'revise-stage', stageId: world.stages[0] as string, archived: true },
      }),
    )
    const [row] =
      await administrator`select stage_id, status from opportunities where id = ${world.opportunityId}`
    expect(row).toEqual({ stage_id: world.stages[0], status: 'open' })
    valid(
      await change.execute({
        context,
        pipelineId: world.pipelineId,
        change: { kind: 'reorder', stageIds: [...world.stages].reverse() },
      }),
    )
    const stages = (await database.pipelineDetail(world.tenantId, world.pipelineId))?.stages
    expect(stages?.map((stage) => stage.id)).toEqual([...world.stages].reverse())
    expect(stages?.[2]).toMatchObject({ archived: true, position: 2 })
    const refused = await new CreateOpportunityUseCase(database, clock).execute({
      ...world.request,
      context: world.keyed(),
    })
    expect(refused.value).toMatchObject({ title: 'Conflict' })
  })

  it('opens an opportunity once per idempotency key, even concurrently', async () => {
    const world = await sales()
    const create = new CreateOpportunityUseCase(database, clock)
    const context = world.keyed()
    const [first, second] = await Promise.all([
      create.execute({ ...world.request, context }),
      create.execute({ ...world.request, context }),
    ])
    expect(valid(first)).toEqual(valid(second))
    const [count] =
      await administrator`select count(*)::int as n from opportunities where tenant_id = ${world.tenantId}`
    expect(count?.n).toBe(2)
  })

  it('never shows one tenant another tenant’s pipelines, lists or opportunities', async () => {
    const world = await sales()
    const intruder = randomUUID()
    for (const table of [
      'pipelines',
      'pipeline_stages',
      'list_entries',
      'opportunities',
      'opportunity_events',
    ]) {
      const [owned] =
        await administrator`select count(*)::int as n from ${administrator(table)} where tenant_id = ${world.tenantId}`
      expect(owned?.n, table).toBeGreaterThan(0)
      const visible = await application.begin(async (tx) => {
        await tx`select set_config('app.current_tenant', ${intruder}, true)`
        return tx`select count(*)::int as n from ${tx(table)}`
      })
      expect(visible[0]?.n, table).toBe(0)
    }
    expect(await database.opportunityDetail(intruder, world.opportunityId)).toBeNull()
  })
})
