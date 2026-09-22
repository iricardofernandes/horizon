import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createFiscalServer } from './api'
import type { FiscalPrincipal } from './auth'

const tenantId = randomUUID()
const documentId = randomUUID()
const otherTenant = randomUUID()
let role: FiscalPrincipal['role'] = 'viewer'
const server = createFiscalServer({
  verifier: {
    async verify(authorization) {
      if (authorization !== 'Bearer test') throw new Error('Invalid token')
      return { tenantId, subject: randomUUID(), role }
    },
  },
  documents: {
    async createDraft(input) {
      if (input.tenantId !== tenantId || !input.actorId) throw new Error('Wrong tenant or actor')
      return { id: documentId, status: 'draft', snapshotDigest: 'a'.repeat(64) }
    },
    async get(requestedTenant, requestedDocument) {
      if (requestedTenant !== tenantId || requestedDocument !== documentId) return null
      return {
        id: documentId,
        status: 'draft',
        simulated: true,
        snapshotDigest: 'a'.repeat(64),
        model: '55',
        environment: 'simulation',
        establishmentId: randomUUID(),
        series: 1,
        number: null,
        createdAt: '2026-09-21T00:00:00.000Z',
      }
    },
  },
  artifacts: {
    async get(requestedTenant) {
      if (requestedTenant !== tenantId) throw new Error('Not found')
      return {
        bytes: Buffer.from('<xml/>'),
        metadata: {
          tenantId,
          documentId,
          kind: 'xml',
          digest: 'a'.repeat(64),
          size: 6,
          mediaType: 'application/xml',
          sourceSchema: 'test',
          createdAt: '2026-09-21T00:00:00.000Z',
        },
      }
    },
  },
})
let base: string

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fiscal test server has no port')
  base = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

it('requires a token and reports every capability unsupported', async () => {
  expect((await fetch(`${base}/capabilities`)).status).toBe(401)
  const response = await fetch(`${base}/capabilities?model=55`, {
    headers: { authorization: 'Bearer test' },
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ defaultStatus: 'unsupported', supported: [] })
})

it('restricts transmission and returns only tenant-scoped document reads', async () => {
  const headers = { authorization: 'Bearer test' }
  expect((await fetch(`${base}/documents/${documentId}`, { headers })).status).toBe(200)
  expect((await fetch(`${base}/documents/${otherTenant}`, { headers })).status).toBe(404)
  expect(
    (await fetch(`${base}/documents/${documentId}/issue`, { method: 'POST', headers })).status,
  ).toBe(403)
  role = 'issuer'
  try {
    expect(
      (await fetch(`${base}/documents/${documentId}/issue`, { method: 'POST', headers })).status,
    ).toBe(409)
  } finally {
    role = 'viewer'
  }
})

it('creates only simulation drafts with an idempotency key for an issuer', async () => {
  role = 'issuer'
  try {
    const body = JSON.stringify({
      intentId: randomUUID(),
      model: '55',
      environment: 'simulation',
      establishmentId: randomUUID(),
      series: 1,
    })
    expect(
      (
        await fetch(`${base}/documents`, {
          method: 'POST',
          headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
          body,
        })
      ).status,
    ).toBe(400)
    const result = await fetch(`${base}/documents`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body,
    })
    expect(result.status).toBe(201)
    expect(await result.json()).toMatchObject({ id: documentId, status: 'draft' })
  } finally {
    role = 'viewer'
  }
})
