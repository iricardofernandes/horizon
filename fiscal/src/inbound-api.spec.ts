import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createFiscalServer } from './api'
import type { FiscalPrincipal } from './auth'
import type { InboundDependencies } from './inbound-api'
import { InboundReconciliationError } from './inbound-reconciliations'
import { InboundRejection } from './nfe55/inbound'

const tenantId = randomUUID()
const importId = randomUUID()
let role: FiscalPrincipal['role'] = 'reviewer'
let imported: { tenantId: string; xml: Buffer } | null = null
let reconcileInput: unknown = null
let nextImport: () => Promise<Awaited<ReturnType<InboundDependencies['imports']['import']>>>
let nextReconcile: () => Promise<
  Awaited<ReturnType<InboundDependencies['reconciliations']['reconcile']>>
>

const inbound: InboundDependencies = {
  imports: {
    async import(input) {
      imported = { tenantId: input.tenantId, xml: input.xml }
      return nextImport()
    },
    async list(requested, query) {
      return {
        data: requested === tenantId ? [] : [],
        page: { hasMore: false, ...(query.cursor ? { nextCursor: query.cursor } : {}) },
      }
    },
    async get(requested, id) {
      return requested === tenantId && id === importId ? ({ id } as never) : null
    },
    async xml(requested, id) {
      return requested === tenantId && id === importId
        ? { bytes: Buffer.from('<NFe/>'), digest: 'a'.repeat(64) }
        : null
    },
    async dismissConflict() {
      return 'dismissed'
    },
  },
  reconciliations: {
    async reconcile(input) {
      reconcileInput = input
      return nextReconcile()
    },
  },
}

const server = createFiscalServer({
  verifier: {
    async verify(authorization) {
      if (authorization !== 'Bearer test') throw new Error('Invalid token')
      return { tenantId, subject: 'user:reviewer', role }
    },
  },
  documents: {} as never,
  manualOrigins: {} as never,
  artifacts: {} as never,
  calculations: {} as never,
  capabilities: {} as never,
  readiness: {} as never,
  rules: {} as never,
  inbound,
})
let base: string

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const post = (path: string, body: BodyInit, headers: Record<string, string>) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    body,
    headers: { authorization: 'Bearer test', ...headers },
  })

it('lets only reviewers and admins reach supplier imports', async () => {
  role = 'issuer'
  const denied = await fetch(`${base}/imports`, { headers: { authorization: 'Bearer test' } })
  expect(denied.status).toBe(403)
  role = 'reviewer'
  const listed = await fetch(`${base}/imports?status=open&limit=5`, {
    headers: { authorization: 'Bearer test' },
  })
  expect(listed.status).toBe(200)
  expect(listed.headers.get('cache-control')).toBe('private, no-store')
  expect(
    (await fetch(`${base}/imports?status=weird`, { headers: { authorization: 'Bearer test' } }))
      .status,
  ).toBe(400)
})

it('accepts XML only, bounds its size and maps refusals and conflicts', async () => {
  nextImport = async () => ({ outcome: 'created', importId, conflictId: null })
  expect((await post('/imports', '{}', { 'content-type': 'application/json' })).status).toBe(415)
  const huge = await post('/imports', Buffer.alloc(1024 * 1024 + 10, 0x20), {
    'content-type': 'application/xml',
  })
  expect(huge.status).toBe(413)
  expect((await huge.json()).code).toBe('XML_TOO_LARGE')

  const created = await post('/imports', '<NFe/>', { 'content-type': 'application/xml' })
  expect(created.status).toBe(201)
  expect(imported).toEqual({ tenantId, xml: Buffer.from('<NFe/>') })

  nextImport = async () => ({ outcome: 'duplicate', importId, conflictId: null })
  expect((await post('/imports', '<NFe/>', { 'content-type': 'text/xml' })).status).toBe(200)

  const conflictId = randomUUID()
  nextImport = async () => ({ outcome: 'conflict', importId, conflictId })
  const conflict = await post('/imports', '<NFe/>', { 'content-type': 'application/xml' })
  expect(conflict.status).toBe(409)
  expect(await conflict.json()).toMatchObject({
    code: 'CONFLICTING_DUPLICATE',
    importId,
    conflictId,
  })

  nextImport = async () => {
    throw new InboundRejection('SIGNATURE_INVALID', 'NF-e XML signature is invalid')
  }
  const refused = await post('/imports', '<NFe/>', { 'content-type': 'application/xml' })
  expect(refused.status).toBe(422)
  expect(await refused.json()).toMatchObject({ code: 'SIGNATURE_INVALID' })
})

it('serves tenant-scoped reads and the original XML with its digest', async () => {
  const auth = { authorization: 'Bearer test' }
  expect((await fetch(`${base}/imports/${importId}`, { headers: auth })).status).toBe(200)
  expect((await fetch(`${base}/imports/${randomUUID()}`, { headers: auth })).status).toBe(404)
  const xml = await fetch(`${base}/imports/${importId}/xml`, { headers: auth })
  expect(xml.status).toBe(200)
  expect(xml.headers.get('digest')).toBe(
    `sha-256=${Buffer.from('a'.repeat(64), 'hex').toString('base64')}`,
  )
  expect(xml.headers.get('x-content-type-options')).toBe('nosniff')
})

it('requires an idempotency key and maps reconciliation outcomes', async () => {
  const body = JSON.stringify({
    supplierPartyId: randomUUID(),
    lines: [],
    unmatchedLines: [1],
    rememberMappings: false,
  })
  const path = `/imports/${importId}/reconciliation`
  expect((await post(path, body, { 'content-type': 'application/json' })).status).toBe(400)
  const headers = { 'content-type': 'application/json', 'idempotency-key': 'reconcile-0000000001' }
  nextReconcile = async () => ({ reconciliation: { id: importId } as never, replayed: false })
  expect((await post(path, body, headers)).status).toBe(201)
  expect(reconcileInput).toMatchObject({ tenantId, importId, actorId: 'user:reviewer' })
  nextReconcile = async () => ({ reconciliation: { id: importId } as never, replayed: true })
  expect((await post(path, body, headers)).status).toBe(200)

  for (const [code, status] of [
    ['NOT_FOUND', 404],
    ['BLOCKED', 409],
    ['OVERRIDE_REQUIRED', 409],
    ['ALLOCATION_INVALID', 422],
    ['NO_RECEIPT', 422],
  ] as const) {
    nextReconcile = async () => {
      throw new InboundReconciliationError(code, 'refused')
    }
    const response = await post(path, body, headers)
    expect(response.status).toBe(status)
    expect((await response.json()).code).toBe(code)
  }
  expect((await post(path, '{"lines":[]}', headers)).status).toBe(400)
})
