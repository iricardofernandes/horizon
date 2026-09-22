import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createFiscalServer } from './api'
import type { FiscalPrincipal } from './auth'

const tenantId = randomUUID()
const documentId = randomUUID()
const otherTenant = randomUUID()
const lineId = randomUUID()
let previewInput: unknown
let readinessInput: unknown
let correctionInput: unknown
let statusQueryInput: unknown
let cancellationInput: unknown
let cancellationQueryInput: unknown
let role: FiscalPrincipal['role'] = 'viewer'
const server = createFiscalServer({
  verifier: {
    async verify(authorization) {
      if (authorization !== 'Bearer test') throw new Error('Invalid token')
      return { tenantId, subject: randomUUID(), role }
    },
  },
  documents: {
    async timeline(requestedTenant, requestedDocument) {
      if (requestedTenant !== tenantId || requestedDocument !== documentId) return null
      return {
        documentId,
        transitions: [
          {
            id: randomUUID(),
            documentId,
            from: null,
            to: 'draft',
            actorId: 'system:fiscal',
            commandId: null,
            reason: null,
            correlationId: null,
            occurredAt: '2026-09-21T00:00:00.000Z',
          },
        ],
      }
    },
    async createSuccessor(input) {
      correctionInput = input
      return {
        id: randomUUID(),
        status: 'draft',
        snapshotDigest: 'a'.repeat(64),
        rootDocumentId: documentId,
        predecessorDocumentId: documentId,
        revision: 2,
        existing: false,
      }
    },
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
        rootDocumentId: documentId,
        predecessorDocumentId: null,
        revision: 1,
        origin: { kind: 'sales', intentId: randomUUID() },
        accessKey: null,
        calculationDigest: null,
        signedXmlDigest: null,
        adapterVersion: null,
        schemaPackageDigest: null,
        statusUrl: `/fiscal/documents/${documentId}`,
        createdAt: '2026-09-21T00:00:00.000Z',
      }
    },
  },
  dispatch: {
    async queueStatusQuery(input) {
      statusQueryInput = input
      return {
        commandId: randomUUID(),
        documentId,
        kind: 'status_query',
        status: 'unknown',
        existing: false,
      }
    },
    async queueCancellationQuery(input) {
      cancellationQueryInput = input
      return {
        commandId: randomUUID(),
        documentId,
        kind: 'cancellation_query',
        status: 'cancellation_unknown',
        existing: false,
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
  capabilities: {
    async listActive() {
      return []
    },
  },
  readiness: {
    async validate(input) {
      readinessInput = input
      return {
        ...calculationResult(),
        capabilityId: randomUUID(),
        reconciliationDigest: '9'.repeat(64),
      }
    },
  },
  issuance: {
    async issue(input) {
      if (input.tenantId !== tenantId || input.documentId !== documentId)
        throw new Error('Wrong issuance scope')
      return {
        commandId: randomUUID(),
        documentId,
        kind: 'issuance',
        status: 'queued',
        existing: false,
        accessKey: '35260900000000E08G12550010000000011123456783',
        unsignedXmlDigest: '7'.repeat(64),
        signedXmlDigest: '8'.repeat(64),
        simulated: true,
      }
    },
  },
  cancellation: {
    async request(input) {
      cancellationInput = input
      return {
        commandId: randomUUID(),
        documentId,
        status: 'cancellation_pending',
        statusUrl: `/fiscal/documents/${documentId}`,
        simulated: true,
        existing: false,
      }
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

it('scopes correction and explicit status consultation to the caller tenant', async () => {
  role = 'issuer'
  const headers = { authorization: 'Bearer test', 'idempotency-key': 'phase42-api-command-0001' }
  const correctedIntentId = randomUUID()
  const correction = await fetch(`${base}/documents/${documentId}/corrections`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      reason: 'Correct owner-approved commercial facts',
      correctedOrigin: { kind: 'sales', intentId: correctedIntentId },
    }),
  })
  expect(correction.status).toBe(201)
  expect(correctionInput).toMatchObject({
    tenantId,
    documentId,
    correctedIntentId,
    idempotencyKey: headers['idempotency-key'],
  })
  const query = await fetch(`${base}/documents/${documentId}/status-queries`, {
    method: 'POST',
    headers,
  })
  expect(query.status).toBe(202)
  expect(statusQueryInput).toMatchObject({ tenantId, documentId })
  role = 'viewer'
})

it('requires the cancellation role and a reviewed reason for both cancellation commands', async () => {
  const headers = {
    authorization: 'Bearer test',
    'idempotency-key': '00000000000000000000000000000011',
    'content-type': 'application/json',
  }
  const request = () =>
    fetch(`${base}/documents/${documentId}/cancellation-requests`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ reason: 'Cancelamento solicitado pelo emitente' }),
    })
  expect((await request()).status).toBe(403)
  role = 'issuer'
  try {
    expect(
      (
        await fetch(`${base}/documents/${documentId}/cancellation-requests`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ reason: 'curta' }),
        })
      ).status,
    ).toBe(422)
    const result = await request()
    expect(result.status).toBe(202)
    expect(cancellationInput).toMatchObject({ tenantId, documentId })
    const consultation = await fetch(`${base}/documents/${documentId}/cancellation-queries`, {
      method: 'POST',
      headers,
    })
    expect(consultation.status).toBe(202)
    expect(cancellationQueryInput).toMatchObject({ tenantId, documentId })
  } finally {
    role = 'viewer'
  }
})

it('serves typed simulation artifacts with digest selection and sandbox headers', async () => {
  const response = await fetch(
    `${base}/documents/${documentId}/artifacts/signed_xml?digest=${'a'.repeat(64)}`,
    { headers: { authorization: 'Bearer test' } },
  )
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(response.headers.get('content-security-policy')).toBe('sandbox')
  expect(await response.text()).toBe('<xml/>')
})

it('serves a tenant-scoped document transition timeline', async () => {
  const headers = { authorization: 'Bearer test' }
  const response = await fetch(`${base}/documents/${documentId}/transitions`, { headers })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    documentId,
    transitions: [{ from: null, to: 'draft' }],
  })
  expect((await fetch(`${base}/documents/${otherTenant}/transitions`, { headers })).status).toBe(
    404,
  )
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
    ).toBe(400)
    const issued = await fetch(`${base}/documents/${documentId}/issue`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': 'phase42-api-issue-0001' },
    })
    expect(issued.status).toBe(202)
    expect(await issued.json()).toMatchObject({
      documentId,
      status: 'queued',
      simulated: true,
    })
    const ready = await fetch(`${base}/documents/${documentId}/validate`, {
      method: 'POST',
      headers,
    })
    expect(ready.status).toBe(200)
    expect(readinessInput).toMatchObject({ tenantId, documentId })
    expect(await ready.json()).toMatchObject({
      document: { id: documentId, status: 'draft' },
      reconciliationDigest: '9'.repeat(64),
    })
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
