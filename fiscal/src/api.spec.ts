import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createFiscalServer } from './api'
import type { FiscalPrincipal } from './auth'

const tenantId = randomUUID()
const documentId = randomUUID()
const otherTenant = randomUUID()
const lineId = randomUUID()
let previewInput: unknown
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
  calculations: {
    async preview(input) {
      previewInput = input
      return {
        schemaVersion: 1,
        supported: false,
        code: 'UNSUPPORTED_RULE',
        detail: 'No reviewed rule matches',
        missingDimension: lineId,
        inputDigest: 'b'.repeat(64),
      }
    },
    async get(requestedTenant, requestedDocument) {
      if (requestedTenant !== tenantId || requestedDocument !== documentId) return null
      return calculationResult()
    },
  },
  rules: {
    async proposeOverride(input) {
      if (input.tenantId !== tenantId || !input.actorId) throw new Error('Wrong tenant or actor')
      return {
        id: randomUUID(),
        status: 'proposed',
        beforeDigest: 'e'.repeat(64),
        proposedDigest: 'f'.repeat(64),
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

it('previews with the authenticated tenant and returns a stable typed problem', async () => {
  const response = await fetch(`${base}/calculations/preview`, {
    method: 'POST',
    headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 1, tenantId: otherTenant }),
  })
  expect(response.status).toBe(422)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(previewInput).toMatchObject({ tenantId })
  expect(await response.json()).toMatchObject({
    type: 'https://horizon.dev/problems/fiscal/unsupported-rule',
    code: 'UNSUPPORTED_RULE',
    missingDimension: lineId,
  })
})

it('reads frozen calculations and saved explanations without selecting current rules', async () => {
  const headers = { authorization: 'Bearer test' }
  const calculation = await fetch(`${base}/documents/${documentId}/calculation`, { headers })
  expect(calculation.status).toBe(200)
  expect(calculation.headers.get('cache-control')).toBe('private, no-store')
  expect(await calculation.json()).toMatchObject({ supported: true, resultDigest: 'c'.repeat(64) })
  const explanation = await fetch(`${base}/documents/${documentId}/calculation/explanation`, {
    headers,
  })
  expect(explanation.status).toBe(200)
  expect(await explanation.json()).toMatchObject({
    documentId,
    explanation: { templateVersion: 'fiscal-explanation-v1' },
    sources: [{ digest: 'd'.repeat(64) }],
  })
  expect((await fetch(`${base}/documents/${otherTenant}/calculation`, { headers })).status).toBe(
    404,
  )
})

it('restricts immutable override proposals to rules managers', async () => {
  const request = () =>
    fetch(`${base}/rule-overrides`, {
      method: 'POST',
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      body: JSON.stringify({
        predecessorRuleId: randomUUID(),
        proposedDefinition: { rate: { numerator: '2', denominator: '10' } },
        sourceBasisUri: 'https://example.invalid/correction',
        sourceBasisSection: 'fixture-only',
        reason: 'Illustrative correction request',
      }),
    })
  expect((await request()).status).toBe(403)
  role = 'admin'
  try {
    const response = await request()
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ status: 'proposed' })
  } finally {
    role = 'viewer'
  }
})

function calculationResult() {
  const source = {
    packageId: randomUUID(),
    digest: 'd'.repeat(64),
    uri: 'https://example.invalid/source',
    section: 'fixture-only',
  }
  return {
    schemaVersion: 1 as const,
    supported: true as const,
    inputDigest: 'a'.repeat(64),
    rulesDigest: 'b'.repeat(64),
    resultDigest: 'c'.repeat(64),
    lines: [
      {
        lineId,
        gross: { amount: '1000', currency: 'BRL' },
        net: { amount: '1000', currency: 'BRL' },
        components: {
          legacy: [
            {
              code: 'ILLUSTRATIVE_TAX',
              base: { amount: '1000', currency: 'BRL' },
              rate: { numerator: '1', denominator: '10' },
              unrounded: { numerator: '100', denominator: '1', currency: 'BRL' },
              amount: { amount: '100', currency: 'BRL' },
              formula: 'LINE_NET_TIMES_RATE',
              rounding: { mode: 'half-away-from-zero' as const, scale: 0 },
              rule: { id: randomUUID(), version: 1 },
              source,
            },
          ],
          ibsCbs: [],
        },
      },
    ],
    totals: {
      gross: { amount: '1000', currency: 'BRL' },
      discounts: { amount: '0', currency: 'BRL' },
      charges: { amount: '0', currency: 'BRL' },
      net: { amount: '1000', currency: 'BRL' },
      legacyTax: { amount: '100', currency: 'BRL' },
      ibsCbsTax: { amount: '0', currency: 'BRL' },
    },
    reconciliation: {
      lineNetSum: { amount: '1000', currency: 'BRL' },
      legacyComponentSum: { amount: '100', currency: 'BRL' },
      ibsCbsComponentSum: { amount: '0', currency: 'BRL' },
      balanced: true as const,
    },
    explanation: { templateVersion: 'fiscal-explanation-v1', text: 'Illustrative explanation' },
  }
}
