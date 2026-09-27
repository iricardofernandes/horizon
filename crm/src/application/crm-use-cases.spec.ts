import { randomBytes, randomUUID } from 'node:crypto'
import type { EventEnvelope } from '@horizon/contracts'
import { InMemoryCrmUnitOfWork } from 'test/repositories/in-memory-crm-unit-of-work'
import { snapshotOf } from 'test/support/snapshot-of'
import { describe, expect, it } from 'vitest'
import type { Either } from '@/core/either'
import { CrmModuleEventHandlers } from './consume-module-events'
import { UpdateAccountProfileUseCase } from './use-cases/manage-accounts'
import {
  ChangeContactStatusUseCase,
  CreateContactUseCase,
  EraseContactUseCase,
  ReviseContactUseCase,
} from './use-cases/manage-contacts'

function valid<L, R>(result: Either<L, R>): R {
  if (result.isLeft()) throw result.value
  return result.value
}

const now = new Date('2026-09-27T12:00:00Z')
const clock = { now: () => now }

function envelope(
  eventType: string,
  tenantId: string,
  payload: unknown,
  eventVersion = 1,
): EventEnvelope {
  return {
    eventId: randomUUID(),
    eventType,
    eventVersion,
    occurredAt: now.toISOString(),
    tenantId,
    traceId: randomBytes(16).toString('hex'),
    payload,
  }
}

const party = {
  legalName: 'Acme GmbH',
  tradeName: null,
  email: null,
  phone: null,
  address: null,
  documentType: 'foreign',
  documentCountry: 'DE',
}

function setup() {
  const unitOfWork = new InMemoryCrmUnitOfWork()
  const handlers = new CrmModuleEventHandlers(unitOfWork, clock)
  const deliver = async (event: EventEnvelope) => {
    const handler = handlers.handlers[event.eventType]
    if (!handler) throw new Error(`no handler for ${event.eventType}`)
    await handler(event)
  }
  return {
    unitOfWork,
    deliver,
    profile: new UpdateAccountProfileUseCase(unitOfWork, clock),
    create: new CreateContactUseCase(unitOfWork, clock),
    revise: new ReviseContactUseCase(unitOfWork, clock),
    status: new ChangeContactStatusUseCase(unitOfWork, clock),
    erase: new EraseContactUseCase(unitOfWork, clock),
  }
}

async function prospectAccount(world: ReturnType<typeof setup>, tenantId = randomUUID()) {
  const partyId = randomUUID()
  await world.deliver(
    envelope(
      'parties.party.registered',
      tenantId,
      { partyId, kind: 'organization', ...party, roles: ['prospect'] },
      2,
    ),
  )
  return { tenantId, partyId }
}

/** The projected account, as the boundary would present it. */
function accountOf(world: ReturnType<typeof setup>, id: string) {
  const account = world.unitOfWork.accounts.get(id)
  if (!account) throw new Error(`no account ${id}`)
  return snapshotOf(account)
}

const command = (tenantId: string, actor = 'ana') => ({ tenantId, actor, requestId: null })
const contactInput = {
  name: 'João Lima',
  email: 'joao@acme.example',
  lawfulBasis: 'legitimate-interest',
}

describe('accounts from party events', () => {
  it('projects a prospect from v2, ignores a supplier, and applies each event once', async () => {
    const world = setup()
    const { tenantId, partyId } = await prospectAccount(world)
    const supplier = randomUUID()
    const registered = envelope(
      'parties.party.registered',
      tenantId,
      { partyId: supplier, kind: 'organization', ...party, roles: ['supplier'] },
      2,
    )
    await world.deliver(registered)
    await world.deliver(registered)
    expect([...world.unitOfWork.accounts.keys()]).toEqual([partyId])
    expect(accountOf(world, partyId)).toMatchObject({
      kind: 'organization',
      documentType: 'foreign',
      documentCountry: 'DE',
      status: 'active',
    })
  })

  it('reads a v1 registration as a CPF or CNPJ and a republished v2 update as an account', async () => {
    const world = setup()
    const tenantId = randomUUID()
    const fromV1 = randomUUID()
    await world.deliver(
      envelope('parties.party.registered', tenantId, {
        partyId: fromV1,
        kind: 'person',
        legalName: 'Maria Souza',
        tradeName: null,
        email: 'maria@example.com',
        phone: '+5511999990000',
        address: 'Rua Um, 1',
        roles: ['customer'],
      }),
    )
    const republished = randomUUID()
    await world.deliver(
      envelope(
        'parties.party.updated',
        tenantId,
        { partyId: republished, kind: 'organization', ...party, roles: ['partner'], active: true },
        2,
      ),
    )
    expect(accountOf(world, fromV1).documentType).toBe('cpf')
    expect(accountOf(world, republished).kind).toBe('organization')

    await world.deliver(
      envelope('parties.party.updated', tenantId, {
        partyId: fromV1,
        legalName: 'Maria S. Souza',
        tradeName: null,
        email: 'maria@example.com',
        phone: '+5511999990000',
        address: 'Rua Um, 1',
        roles: ['supplier'],
        active: true,
      }),
    )
    expect(accountOf(world, fromV1)).toMatchObject({
      legalName: 'Maria S. Souza',
      kind: 'person',
      documentType: 'cpf',
      status: 'inactive',
    })
  })

  it('shreds the contacts of an erased party and blanks its account', async () => {
    const world = setup()
    const { tenantId, partyId } = await prospectAccount(world)
    const { contactId } = valid(
      await world.create.execute({
        context: { ...command(tenantId), idempotencyKey: randomUUID() },
        accountId: partyId,
        contact: contactInput,
      }),
    )
    await world.deliver(envelope('parties.party.erased', tenantId, { partyId }))
    expect(world.unitOfWork.keys.has(contactId)).toBe(false)
    expect(accountOf(world, partyId)).toMatchObject({
      legalName: null,
      status: 'erased',
    })
    await world.deliver(envelope('parties.party.erased', tenantId, { partyId: randomUUID() }))
  })

  it('knows users as owners and never re-enables a disabled one', async () => {
    const world = setup()
    const tenantId = randomUUID()
    const userId = randomUUID()
    await world.deliver(
      envelope('identity.user.registered', tenantId, {
        tenantId,
        userId,
        registeredAt: now.toISOString(),
      }),
    )
    await world.deliver(
      envelope('identity.user.disabled', tenantId, {
        tenantId,
        userId,
        disabledAt: now.toISOString(),
      }),
    )
    await world.deliver(
      envelope('identity.user.registered', tenantId, {
        tenantId,
        userId,
        registeredAt: now.toISOString(),
      }),
    )
    expect(world.unitOfWork.owners.get(`${tenantId}:${userId}`)).toEqual({ userId, active: false })
  })
})

describe('account profile', () => {
  it('assigns an active owner, refuses unknown and disabled ones, and audits the change', async () => {
    const world = setup()
    const { tenantId, partyId } = await prospectAccount(world)
    const active = randomUUID()
    const disabled = randomUUID()
    await world.unitOfWork.inTenant(tenantId, async (scope) => {
      await scope.owners.register(active, now)
      await scope.owners.register(disabled, now)
      await scope.owners.disable(disabled, now)
    })
    const update = (profile: object) =>
      world.profile.execute({ context: command(tenantId), accountId: partyId, profile })
    expect((await update({ ownerId: randomUUID() })).value).toMatchObject({ field: '/ownerId' })
    expect((await update({ ownerId: disabled })).value).toMatchObject({ field: '/ownerId' })
    expect(valid(await update({ ownerId: active, segment: 'Indústria', tags: ['VIP'] }))).toEqual({
      changed: ['ownerId', 'segment', 'tags'],
    })
    expect(valid(await update({ segment: '  ', tags: ['vip'] }))).toEqual({ changed: ['segment'] })
    expect(valid(await update({ tags: ['vip'] }))).toEqual({ changed: [] })
    expect(world.unitOfWork.audit.map((entry) => entry.action)).toEqual([
      'account.profile-changed',
      'account.profile-changed',
    ])
    expect(world.unitOfWork.audit[0]?.details).toMatchObject({ ownerId: active })
    expect((await update({ tags: ['x'.repeat(41)] })).isLeft()).toBe(true)
    expect((await update({ segment: 'x'.repeat(81) })).isLeft()).toBe(true)
    expect(
      (
        await world.profile.execute({
          context: command(tenantId),
          accountId: randomUUID(),
          profile: {},
        })
      ).value,
    ).toMatchObject({ title: 'Resource not found' })
  })
})

describe('contacts', () => {
  it('creates a contact once per key and refuses an inactive or unknown account', async () => {
    const world = setup()
    const { tenantId, partyId } = await prospectAccount(world)
    const context = { ...command(tenantId), idempotencyKey: randomUUID() }
    const first = valid(
      await world.create.execute({ context, accountId: partyId, contact: contactInput }),
    )
    const retry = valid(
      await world.create.execute({ context, accountId: partyId, contact: contactInput }),
    )
    expect(retry).toEqual(first)
    expect(world.unitOfWork.contacts.size).toBe(1)
    expect(world.unitOfWork.audit.at(-1)).toMatchObject({
      action: 'contact.created',
      details: { accountId: partyId, lawfulBasis: 'legitimate-interest' },
    })
    expect(JSON.stringify(world.unitOfWork.audit)).not.toContain('joao')

    const missing = await world.create.execute({
      context: { ...command(tenantId), idempotencyKey: randomUUID() },
      accountId: randomUUID(),
      contact: contactInput,
    })
    expect(missing.value).toMatchObject({ title: 'Resource not found' })
    await world.deliver(
      envelope(
        'parties.party.updated',
        tenantId,
        { partyId, kind: 'organization', ...party, roles: ['prospect'], active: false },
        2,
      ),
    )
    const inactive = await world.create.execute({
      context: { ...command(tenantId), idempotencyKey: randomUUID() },
      accountId: partyId,
      contact: contactInput,
    })
    expect(inactive.value).toMatchObject({ title: 'Conflict' })
    const malformed = await world.create.execute({
      context: { ...command(tenantId), idempotencyKey: randomUUID() },
      accountId: partyId,
      contact: { ...contactInput, lawfulBasis: 'because' },
    })
    expect(malformed.value).toMatchObject({ field: '/lawfulBasis' })
  })

  it('revises, deactivates and erases a contact, auditing field names only', async () => {
    const world = setup()
    const { tenantId, partyId } = await prospectAccount(world)
    const { contactId } = valid(
      await world.create.execute({
        context: { ...command(tenantId), idempotencyKey: randomUUID() },
        accountId: partyId,
        contact: contactInput,
      }),
    )
    const context = command(tenantId)
    expect(
      valid(
        await world.revise.execute({
          context,
          contactId,
          contact: { ...contactInput, phone: '+55 11 98888-7777', jobTitle: 'Comprador' },
        }),
      ),
    ).toEqual({ changed: ['jobTitle', 'phone'] })
    expect(
      valid(
        await world.revise.execute({
          context,
          contactId,
          contact: { ...contactInput, phone: '+5511988887777', jobTitle: 'Comprador' },
        }),
      ),
    ).toEqual({ changed: [] })
    expect((await world.status.execute({ context, contactId, active: false })).isRight()).toBe(true)
    expect((await world.status.execute({ context, contactId, active: false })).isLeft()).toBe(true)
    expect((await world.status.execute({ context, contactId, active: true })).isRight()).toBe(true)
    expect((await world.erase.execute({ context, contactId })).isRight()).toBe(true)
    expect(world.unitOfWork.keys.has(contactId)).toBe(false)
    expect(accountOf(world, partyId).status).toBe('active')
    expect(
      (await world.revise.execute({ context, contactId, contact: contactInput })).isLeft(),
    ).toBe(true)
    expect((await world.erase.execute({ context, contactId: randomUUID() })).value).toMatchObject({
      title: 'Resource not found',
    })
    expect(
      (await world.revise.execute({ context, contactId, contact: { ...contactInput, name: 'J' } }))
        .value,
    ).toMatchObject({ field: '/name' })
    expect(world.unitOfWork.audit.map((entry) => entry.action)).toEqual([
      'contact.created',
      'contact.revised',
      'contact.deactivated',
      'contact.reactivated',
      'contact.erased',
    ])
    expect(world.unitOfWork.audit[1]?.details).toEqual({ changed: ['jobTitle', 'phone'] })
  })

  it('never shows one tenant another tenant’s contact', async () => {
    const world = setup()
    const { tenantId, partyId } = await prospectAccount(world)
    const { contactId } = valid(
      await world.create.execute({
        context: { ...command(tenantId), idempotencyKey: randomUUID() },
        accountId: partyId,
        contact: contactInput,
      }),
    )
    const intruder = await world.erase.execute({ context: command(randomUUID()), contactId })
    expect(intruder.value).toMatchObject({ title: 'Resource not found' })
  })
})
