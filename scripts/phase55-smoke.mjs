#!/usr/bin/env node
/**
 * Phase 55 local-stack smoke through Kong. A prospect registered in Parties becomes a CRM
 * account; parties that existed before CRM arrive through a Parties republish; users
 * arrive as owners, by event and by the one-off backfill; an owner, a segment and tags
 * are assigned; a contact is created once per key, read back, deactivated and erased; a
 * disabled owner, a viewer's write, a representative's reassignment and erasure are
 * refused; and erasing the party blanks the account and shreds its contacts.
 *
 *   node scripts/phase55-smoke.mjs [--tenant <uuid>] [--base-url http://localhost:8000]
 *     [--postgres-container horizon-postgres]
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const tenantId = flag('tenant', '01a0c5f8-798b-721e-912e-9b505406e614')
const baseUrl = flag('base-url', 'http://localhost:8000').replace(/\/$/, '')
const postgresContainer = flag('postgres-container', 'horizon-postgres')

const token = (...roles) =>
  execFileSync(
    process.execPath,
    [
      join(root, 'infra/scripts/mint-dev-token.mjs'),
      '--tenant',
      tenantId,
      '--sub',
      randomUUID(),
      ...roles.flatMap((role) => ['--role', role]),
    ],
    { encoding: 'utf8' },
  ).trim()

const operator = token('parties:admin', 'crm:admin', 'identity:owner')
const viewer = token('crm:viewer')
const representative = token('crm:representative')

async function call(path, { method = 'GET', body, as = operator, key } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${as}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  })
  const text = await response.text()
  const type = response.headers.get('content-type') ?? ''
  return { status: response.status, body: text && type.includes('json') ? JSON.parse(text) : text }
}

async function ok(path, options) {
  const result = await call(path, options)
  if (result.status >= 400)
    throw new Error(`${options?.method ?? 'GET'} ${path}: HTTP ${result.status} ${JSON.stringify(result.body)}`)
  return result.body
}

async function until(label, probe, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) {
      last = error
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ''}`)
}

const sql = (statement) =>
  execFileSync(
    'docker',
    ['exec', postgresContainer, 'psql', '-U', 'postgres', '-d', 'horizon_crm', '-At', '-c', statement],
    { encoding: 'utf8' },
  ).trim()

const inContainer = (container, env, command) =>
  JSON.parse(
    execFileSync('docker', ['exec', ...env.flatMap((pair) => ['-e', pair]), container, ...command], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .at(-1),
  )

const reasonOf = (body) => body.detail ?? body.message
const run = Date.now().toString(36)
const evidence = { checkedAt: new Date().toISOString(), tenantId }

// --- parties that existed before CRM arrive through a republish ---------------------------
const republished = inContainer('horizon-parties', [], [
  'node',
  'dist/main/republish-parties.js',
  '--tenant',
  tenantId,
])
const expected = execFileSync(
  'docker',
  [
    'exec',
    postgresContainer,
    'psql',
    '-U',
    'postgres',
    '-d',
    'horizon_parties',
    '-At',
    '-c',
    `select id from parties where tenant_id = '${tenantId}' and status <> 'erased'
       and roles && array['prospect', 'customer', 'partner']`,
  ],
  { encoding: 'utf8' },
)
  .trim()
  .split('\n')
  .filter(Boolean)
await until('CRM to hold an account for every party with a CRM role', async () => {
  const held = new Set(
    sql(`select id from accounts where tenant_id = '${tenantId}' and status <> 'erased'`).split('\n'),
  )
  return expected.every((id) => held.has(id))
})
evidence.republish = { ...republished, partiesWithCrmRole: expected.length }

// --- users arrive as owners: by the backfill, and by event --------------------------------
const backfill = inContainer(
  'horizon-crm',
  ['IDENTITY_URL=http://kong:8000/identity', `IDENTITY_TOKEN=${operator}`],
  ['node', 'dist/main/backfill-owners.js', '--tenant', tenantId],
)
const user = await ok('/identity/users', {
  method: 'POST',
  body: { email: `owner-${run}@horizon.local`, name: 'CRM Owner', password: `Horizon-${run}-2026!` },
})
const userId = user.userId ?? user.id
await until('CRM to learn the new user as an owner', async () =>
  (await ok('/crm/owners')).data.some((owner) => owner.userId === userId && owner.active),
)
evidence.owners = { backfill, registeredByEvent: userId }

// --- a prospect registered in Parties becomes an account ----------------------------------
const prospect = await ok('/parties/parties', {
  method: 'POST',
  body: {
    kind: 'organization',
    legalName: `Initech ${run} Ltda`,
    document: { type: 'none' },
    roles: ['prospect'],
  },
})
const accountId = prospect.partyId
const account = await until('CRM to project the prospect', async () => {
  const result = await call(`/crm/accounts/${accountId}`)
  return result.status === 200 ? result.body : undefined
})
assert.equal(account.status, 'active')
assert.equal(account.documentType, 'none')
assert.deepEqual(account.roles, ['prospect'])

// --- owner, segment and tags --------------------------------------------------------------
const profiled = await ok(`/crm/accounts/${accountId}`, {
  method: 'PATCH',
  body: { ownerId: userId, segment: 'Indústria', tags: ['VIP', 'sul'] },
})
assert.deepEqual(profiled.changed, ['ownerId', 'segment', 'tags'])
const reassign = await call(`/crm/accounts/${accountId}`, {
  method: 'PATCH',
  as: representative,
  body: { ownerId: null },
})
assert.equal(reassign.status, 403, JSON.stringify(reassign.body))
const tagged = await ok(`/crm/accounts/${accountId}`, {
  method: 'PATCH',
  as: representative,
  body: { tags: ['vip', 'sul', 'novo'] },
})
assert.deepEqual(tagged.changed, ['tags'])
assert.equal((await call(`/crm/accounts/${accountId}`, { method: 'PATCH', as: viewer, body: { tags: [] } })).status, 403)
assert.equal(
  (await ok(`/crm/accounts?ownerId=${userId}`)).data.some((row) => row.id === accountId),
  true,
)

// --- a disabled owner cannot be given accounts --------------------------------------------
await ok(`/identity/users/${userId}/disable`, { method: 'PATCH' })
await until('CRM to learn the user was disabled', async () =>
  (await ok('/crm/owners')).data.some((owner) => owner.userId === userId && !owner.active),
)
const refusedOwner = await call(`/crm/accounts/${accountId}`, {
  method: 'PATCH',
  body: { ownerId: userId, segment: 'Varejo' },
})
assert.equal(refusedOwner.status, 400, JSON.stringify(refusedOwner.body))
assert.match(reasonOf(refusedOwner.body), /disabled user/)
assert.equal((await ok(`/crm/accounts/${accountId}`)).ownerId, userId, 'the owner keeps the account')
evidence.profile = { changed: profiled.changed, disabledOwner: reasonOf(refusedOwner.body) }

// --- a contact: created once per key, read back, deactivated, erased ----------------------
const key = randomUUID()
const contactBody = {
  name: 'Peter Gibbons',
  jobTitle: 'Engenheiro',
  email: `peter-${run}@initech.example`,
  phone: '+55 11 97777-6666',
  lawfulBasis: 'legitimate-interest',
}
const created = await ok(`/crm/accounts/${accountId}/contacts`, { method: 'POST', key, body: contactBody })
const retried = await ok(`/crm/accounts/${accountId}/contacts`, { method: 'POST', key, body: contactBody })
assert.equal(retried.contactId, created.contactId)
const { contactId } = created
assert.equal((await call(`/crm/accounts/${accountId}/contacts`, { method: 'POST', body: contactBody })).status, 400)
const sealed = sql(`select name_ciphertext || coalesce(email_ciphertext, '') from contacts where id = '${contactId}'`)
assert.ok(!sealed.includes('Peter') && !sealed.includes('initech'), 'contact fields are sealed')
const detail = await ok(`/crm/accounts/${accountId}`)
assert.equal(detail.contacts.length, 1)
assert.equal(detail.contacts[0].email, contactBody.email)
await ok(`/crm/contacts/${contactId}/status`, { method: 'PATCH', as: representative, body: { active: false } })
assert.equal((await call(`/crm/contacts/${contactId}`, { method: 'DELETE', as: representative })).status, 403)
await ok(`/crm/contacts/${contactId}`, { method: 'DELETE' })
const erasedContact = await ok(`/crm/contacts/${contactId}`)
assert.equal(erasedContact.status, 'erased')
assert.equal(erasedContact.name, null)
assert.equal(sql(`select material is null from contact_data_keys where id = '${contactId}'`), 't')
assert.equal((await ok(`/crm/accounts/${accountId}`)).status, 'active')
evidence.contact = { contactId, idempotent: true, erased: true }

// --- erasing the party blanks the account and shreds its contacts -------------------------
const second = await ok(`/crm/accounts/${accountId}/contacts`, {
  method: 'POST',
  key: randomUUID(),
  body: { name: 'Samir', lawfulBasis: 'contract' },
})
await ok(`/parties/parties/${accountId}`, { method: 'DELETE' })
const blanked = await until('CRM to forget the erased party', async () => {
  const read = await ok(`/crm/accounts/${accountId}`)
  return read.status === 'erased' ? read : undefined
})
assert.equal(blanked.legalName, null)
assert.equal(sql(`select material is null from contact_data_keys where id = '${second.contactId}'`), 't')
evidence.partyErasure = {
  accountStatus: blanked.status,
  contactsErased: blanked.contacts.filter((contact) => contact.status === 'erased').length,
}

console.log(JSON.stringify(evidence, null, 2))
