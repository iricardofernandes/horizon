import { randomBytes, randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  ChangePartyRoleUseCase,
  ErasePartyUseCase,
  RegisterPartyUseCase,
} from '@/application/use-cases/manage-parties'
import { AesGcmSecretBox } from '@/infrastructure/cryptography/aes-gcm-secret-box'
import { PartiesDatabase } from '@/infrastructure/database/drizzle/parties-database'

const clock = { now: () => new Date() }
let database: PartiesDatabase
let application: ReturnType<typeof postgres>
let administrator: ReturnType<typeof postgres>

beforeAll(() => {
  database = new PartiesDatabase({
    url: process.env.DATABASE_URL ?? '',
    privacy: { secretBox: new AesGcmSecretBox(), blindIndexKey: randomBytes(32) },
  })
  application = postgres(process.env.DATABASE_URL ?? '', { max: 1 })
  administrator = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
})

afterAll(async () => {
  await Promise.allSettled([database?.close(), application?.end(), administrator?.end()])
})

const details = {
  kind: 'organization' as const,
  legalName: 'Torrefação Serra LTDA',
  email: 'compras@serra.example',
  phone: '+5511999990000',
  address: 'Rua das Flores, 10, São Paulo',
}

async function register(tenantId: string, taxId = '12345678000195', roles = ['supplier']) {
  const result = await new RegisterPartyUseCase(database, clock).execute({
    ...details,
    tenantId,
    taxId,
    roles,
  })
  if (result.isLeft()) throw result.value
  return result.value.partyId
}

it('stores personal data only as ciphertext and publishes the registration', async () => {
  const tenantId = randomUUID()
  const partyId = await register(tenantId)

  const [row] = await administrator`select legal_name_ciphertext, tax_id_ciphertext, tax_id_index
    from parties where id = ${partyId}`
  expect(JSON.stringify(row)).not.toContain('Serra')
  expect(JSON.stringify(row)).not.toContain('12345678000195')

  const events = await administrator`select event_type from outbox where tenant_id = ${tenantId}`
  expect(events.map((event) => event.event_type)).toEqual(['parties.party.registered'])

  const snapshot = await database.findSnapshot(tenantId, partyId)
  expect(snapshot).toMatchObject({ legalName: 'Torrefação Serra LTDA', roles: ['supplier'] })
})

it('refuses a second party with the same tax identifier and points to granting a role', async () => {
  const tenantId = randomUUID()
  const partyId = await register(tenantId)

  const duplicate = await new RegisterPartyUseCase(database, clock).execute({
    ...details,
    tenantId,
    taxId: '12.345.678/0001-95',
    roles: ['customer'],
  })
  expect(duplicate.isLeft()).toBe(true)

  const granted = await new ChangePartyRoleUseCase(database, clock).execute({
    tenantId,
    partyId,
    role: 'customer',
    operation: 'grant',
  })
  expect(granted.isRight()).toBe(true)
  const [row] = await administrator`select roles from parties where id = ${partyId}`
  expect(row?.roles).toEqual(['customer', 'supplier'])
})

it('lets the same tax identifier exist once in each tenant', async () => {
  await register(randomUUID())
  await expect(register(randomUUID())).resolves.toBeTypeOf('string')
})

it('adopts an identifier a predecessor already published', async () => {
  const tenantId = randomUUID()
  const adopted = randomUUID()
  const result = await new RegisterPartyUseCase(database, clock).execute({
    ...details,
    tenantId,
    partyId: adopted,
    taxId: '12345678000195',
    roles: ['customer'],
  })
  expect(result.isRight() && result.value.partyId).toBe(adopted)
})

it('erases by destroying the key, and the row can no longer be opened', async () => {
  const tenantId = randomUUID()
  const partyId = await register(tenantId)

  const erased = await new ErasePartyUseCase(database, clock).execute({ tenantId, partyId })
  expect(erased.isRight()).toBe(true)

  const [key] =
    await administrator`select material, erased_at from party_data_keys where id = ${partyId}`
  expect(key?.material).toBeNull()
  expect(key?.erased_at).not.toBeNull()
  expect(await database.findSnapshot(tenantId, partyId)).toMatchObject({
    status: 'erased',
    legalName: 'Erased party',
    roles: [],
  })
  const events = await administrator`select event_type, payload from outbox
    where tenant_id = ${tenantId} order by created_at`
  expect(events.at(-1)).toMatchObject({
    event_type: 'parties.party.erased',
    payload: { partyId },
  })
  // The tax identifier is free again: a new relationship with the same company is a new party.
  await expect(register(tenantId)).resolves.not.toBe(partyId)
})

it('never shows one tenant another tenant’s parties', async () => {
  const owner = randomUUID()
  const partyId = await register(owner)
  const intruder = randomUUID()

  const rows = await application.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${intruder}, true)`
    return tx`select id from parties where id = ${partyId}`
  })
  expect(rows).toHaveLength(0)
  expect(await database.findSnapshot(intruder, partyId)).toBeNull()
})

it('refuses an outbox row written for another tenant', async () => {
  const tenantId = randomUUID()
  await register(tenantId)
  await expect(
    application.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      await tx`insert into outbox (id, tenant_id, event_id, event_type, event_version, occurred_at, trace_id, payload)
        values (${randomUUID()}, ${randomUUID()}, ${randomUUID()}, 'parties.party.erased', 1, now(), 'x', '{}')`
    }),
  ).rejects.toThrow()
})
