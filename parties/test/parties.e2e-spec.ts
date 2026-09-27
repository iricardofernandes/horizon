import { randomBytes, randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  ChangePartyRoleUseCase,
  DescribePartyFiscalProfileUseCase,
  ErasePartyUseCase,
  FindLookalikePartiesUseCase,
  IdentifyPartyUseCase,
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

it('keeps alphanumeric CNPJ letters through encryption and deduplicates case and mask', async () => {
  const tenantId = randomUUID()
  const partyId = await register(tenantId, '00.000.000/e08g-12')
  const snapshot = await database.findSnapshot(tenantId, partyId)
  expect(snapshot?.document).toEqual({ type: 'cnpj', number: '00000000E08G12', country: null })

  const duplicate = await new RegisterPartyUseCase(database, clock).execute({
    ...details,
    tenantId,
    taxId: '00000000E08G12',
    roles: ['customer'],
  })
  expect(duplicate.isLeft()).toBe(true)

  const [row] =
    await administrator`select tax_id_ciphertext, tax_id_index from parties where id = ${partyId}`
  expect(JSON.stringify(row)).not.toContain('E08G')
})

it('stores versioned fiscal details encrypted and excludes them from general party events', async () => {
  const tenantId = randomUUID()
  const partyId = await register(tenantId, '00.000.000/E08G-12')
  const first = await new DescribePartyFiscalProfileUseCase(database, clock).execute({
    tenantId,
    partyId,
    profile: {
      effectiveFrom: '2026-09-01',
      stateRegistration: '123456',
      municipalRegistration: null,
      taxpayerIndicator: 'contributor',
      finalConsumer: false,
      address: {
        street: 'Rua Um',
        number: '42',
        complement: null,
        district: 'Centro',
        city: 'São Paulo',
        municipalityCode: '3550308',
        state: 'SP',
        postalCode: '01001000',
        country: 'BR',
      },
    },
  })
  if (first.isLeft()) throw first.value
  expect(first.value).toBe(1)
  const exported = await database.findFiscalExport(tenantId, partyId, 1)
  expect(exported).toMatchObject({
    taxId: '00000000E08G12',
    profile: { address: { municipalityCode: '3550308' } },
  })
  const [row] =
    await administrator`select fiscal_profile_ciphertext from parties where id = ${partyId}`
  expect(JSON.stringify(row)).not.toContain('3550308')
  const [history] =
    await administrator`select ciphertext from party_fiscal_profiles where party_id = ${partyId}`
  expect(JSON.stringify(history)).not.toContain('E08G')
  const events =
    await administrator`select event_type,payload from outbox where tenant_id = ${tenantId}`
  const notice = events.find((event) => event.event_type === 'parties.party.fiscal-profile-changed')
  expect(notice?.payload).toMatchObject({ partyId, revision: 1, effectiveFrom: '2026-09-01' })
  expect(JSON.stringify(notice)).not.toContain('3550308')
  expect(JSON.stringify(notice)).not.toContain('E08G')
  expect(await database.listFiscalProfileRevisions(tenantId, 1)).toEqual({
    tenantId,
    data: [{ partyId, revision: 1 }],
    nextCursor: null,
  })
  const otherTenant = randomUUID()
  expect(await database.listFiscalProfileRevisions(otherTenant, 1)).toEqual({
    tenantId: otherTenant,
    data: [],
    nextCursor: null,
  })
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

it('stores a foreign document encrypted, unique per country, and publishes only its type', async () => {
  const tenantId = randomUUID()
  const registered = await new RegisterPartyUseCase(database, clock).execute({
    tenantId,
    kind: 'organization',
    legalName: 'Acme GmbH',
    document: { type: 'foreign', country: 'DE', number: 'HRB 98765' },
    roles: ['prospect'],
  })
  if (registered.isLeft()) throw registered.value
  const { partyId } = registered.value
  const [row] = await administrator`select document_type, document_country, tax_id_ciphertext,
    email_ciphertext, name_index from parties where id = ${partyId}`
  expect(row).toMatchObject({
    document_type: 'foreign',
    document_country: 'DE',
    email_ciphertext: null,
  })
  expect(JSON.stringify(row)).not.toContain('98765')
  expect(row?.name_index).toMatch(/^[0-9a-f]{64}$/)

  const [event] =
    await administrator`select event_version, payload from outbox where tenant_id = ${tenantId}`
  expect(event).toMatchObject({
    event_version: 2,
    payload: { documentType: 'foreign', documentCountry: 'DE', email: null },
  })
  expect(JSON.stringify(event)).not.toContain('98765')

  const again = await new RegisterPartyUseCase(database, clock).execute({
    tenantId,
    kind: 'organization',
    legalName: 'Acme Deutschland',
    document: { type: 'foreign', country: 'de', number: 'hrb 98765' },
    roles: [],
  })
  expect(again.isLeft()).toBe(true)
  expect(await database.findSnapshot(tenantId, partyId)).toMatchObject({
    document: { type: 'foreign', country: 'DE', number: 'HRB 98765' },
    email: null,
  })
})

it('registers parties without a document side by side and identifies one later', async () => {
  const tenantId = randomUUID()
  const register = (legalName: string) =>
    new RegisterPartyUseCase(database, clock).execute({
      tenantId,
      kind: 'person',
      legalName,
      document: { type: 'none' },
      roles: ['prospect'],
    })
  const first = await register('Maria Souza')
  const second = await register('João Lima')
  if (first.isLeft() || second.isLeft()) throw new Error('registration failed')
  const identified = await new IdentifyPartyUseCase(database, clock).execute({
    tenantId,
    partyId: first.value.partyId,
    document: { type: 'cpf', number: '123.456.789-01' },
  })
  expect(identified.isRight()).toBe(true)
  const [row] = await administrator`select document_type, tax_id_index from parties
    where id = ${first.value.partyId}`
  expect(row?.document_type).toBe('cpf')
  expect(row?.tax_id_index).toMatch(/^[0-9a-f]{64}$/)
  const [untouched] = await administrator`select tax_id_index from parties
    where id = ${second.value.partyId}`
  expect(untouched?.tax_id_index).toBeNull()

  // The database refuses what the aggregate would: a CPF on an organization.
  await expect(
    administrator`update parties set kind = 'organization' where id = ${first.value.partyId}`,
  ).rejects.toThrow(/parties_document_kind_valid/)
})

it('finds lookalikes through keyed indexes, only in the tenant, and forgets them on erasure', async () => {
  const tenantId = randomUUID()
  const partyId = await register(tenantId)
  const lookalikes = new FindLookalikePartiesUseCase(database)
  const found = await lookalikes.execute({
    tenantId,
    legalName: 'TORREFACAO SERRA',
    phone: '(11) 99999-0000',
  })
  if (found.isLeft()) throw found.value
  expect(found.value.map((match) => [match.party.id.toString(), match.matchedOn])).toEqual([
    [partyId, ['name', 'phone']],
  ])
  const elsewhere = await lookalikes.execute({
    tenantId: randomUUID(),
    legalName: 'Torrefação Serra',
  })
  expect(elsewhere.isRight() && elsewhere.value).toEqual([])

  await new ErasePartyUseCase(database, clock).execute({ tenantId, partyId })
  const [row] = await administrator`select name_index, email_index, phone_index from parties
    where id = ${partyId}`
  expect(row).toEqual({ name_index: null, email_index: null, phone_index: null })
  const after = await lookalikes.execute({ tenantId, legalName: 'Torrefação Serra' })
  expect(after.isRight() && after.value).toEqual([])
})

it('backfills the lookup indexes of rows written before them, once', async () => {
  const tenantId = randomUUID()
  const partyId = await register(tenantId)
  await administrator`update parties set name_index = null, email_index = null, phone_index = null
    where id = ${partyId}`
  expect(await database.backfillLookups(tenantId, 50)).toBe(1)
  expect(await database.backfillLookups(tenantId, 50)).toBe(0)
  const found = await new FindLookalikePartiesUseCase(database).execute({
    tenantId,
    legalName: 'Other',
    email: 'COMPRAS@serra.example',
  })
  expect(found.isRight() && found.value.map((match) => match.party.id.toString())).toEqual([
    partyId,
  ])
})
