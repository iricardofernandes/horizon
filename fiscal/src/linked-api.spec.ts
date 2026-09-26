import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { fiscalDocumentKindCatalogueV2Schema } from '@horizon/contracts'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createFiscalServer } from './api'
import type { FiscalPrincipal } from './auth'
import { CorrectionLetterError } from './correction-letters'
import { LinkedOriginError } from './linked-origins'

const tenantId = randomUUID()
const documentId = randomUUID()
let role: FiscalPrincipal['role'] = 'issuer'
let nextOrigin: () => Promise<unknown> = async () => ({})
let nextLetter: () => Promise<unknown> = async () => ({})
const created: unknown[] = []

const server = createFiscalServer({
  verifier: {
    async verify(authorization) {
      if (authorization !== 'Bearer test') throw new Error('Invalid token')
      return { tenantId, subject: 'user:issuer', role }
    },
  },
  documents: {} as never,
  manualOrigins: {} as never,
  artifacts: {} as never,
  calculations: {} as never,
  capabilities: {} as never,
  readiness: {} as never,
  rules: {} as never,
  linked: {
    origins: {
      async create(input) {
        created.push(input)
        return nextOrigin() as never
      },
      async kindOf() {
        return null
      },
    },
    links: {
      async read(requested, id) {
        return requested === tenantId && id === documentId ? ({ documentId } as never) : null
      },
    },
    correctionLetters: {
      async request() {
        return nextLetter() as never
      },
      async list() {
        return null
      },
    },
  },
})
let base: string

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const send = (method: string, path: string, body?: unknown, key = `key-${randomUUID()}`) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: 'Bearer test',
      'content-type': 'application/json',
      'idempotency-key': key,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

it('lists every document kind with its support status and the model event flows', async () => {
  role = 'viewer'
  const response = await send('GET', '/document-kinds')
  expect(response.status).toBe(200)
  const catalogue = fiscalDocumentKindCatalogueV2Schema.parse(await response.json())
  expect(catalogue.kinds.find((entry) => entry.kind === 'remittance')).toMatchObject({
    supported: false,
  })
  // Model 65 has its own cancellation flow and no correction letter.
  expect(catalogue.eventFlows).toContainEqual({ model: '65', flows: ['cancellation'] })
  expect(catalogue.kinds.find((entry) => entry.kind === 'consumer-sale')).toMatchObject({
    model: '65',
    supported: true,
    operation: 'consumer-sale',
  })
  expect(catalogue.kinds.find((entry) => entry.kind === 'counter-sale')).toMatchObject({
    model: '65',
    supported: false,
  })
})

it('creates linked origins only with draft permission, a key and a known kind', async () => {
  role = 'viewer'
  const request = { kind: 'sale-return', shipmentId: randomUUID() }
  expect((await send('POST', '/linked-origins', request)).status).toBe(403)
  role = 'issuer'
  const withoutKey = await fetch(`${base}/linked-origins`, {
    method: 'POST',
    headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  expect(withoutKey.status).toBe(400)
  expect(
    (await send('POST', '/linked-origins', { kind: 'remittance', shipmentId: randomUUID() }))
      .status,
  ).toBe(400)

  nextOrigin = async () => ({ id: randomUUID(), kind: 'sale-return', existing: false })
  expect((await send('POST', '/linked-origins', request)).status).toBe(201)
  expect(created.at(-1)).toMatchObject({ tenantId, actorId: 'user:issuer', request })
  nextOrigin = async () => ({ id: randomUUID(), kind: 'sale-return', existing: true })
  expect((await send('POST', '/linked-origins', request)).status).toBe(200)
})

it('maps linked origin refusals to stable problem codes', async () => {
  role = 'issuer'
  nextOrigin = async () => {
    throw new LinkedOriginError('QUANTITY_EXCEEDED', 'Linked quantity exceeds the original')
  }
  const exceeded = await send('POST', '/linked-origins', {
    kind: 'purchase-return',
    receiptId: randomUUID(),
    establishmentId: randomUUID(),
  })
  expect(exceeded.status).toBe(422)
  expect(await exceeded.json()).toMatchObject({ code: 'QUANTITY_EXCEEDED' })
  nextOrigin = async () => {
    throw new LinkedOriginError('LINKED_ORIGIN_CONFLICT', 'Conflicting idempotency key')
  }
  expect(
    (await send('POST', '/linked-origins', { kind: 'sale-return', shipmentId: randomUUID() }))
      .status,
  ).toBe(409)
})

it('reads links within the tenant and queues correction letters with attestation', async () => {
  role = 'viewer'
  expect((await send('GET', `/documents/${documentId}/links`)).status).toBe(200)
  expect((await send('GET', `/documents/${randomUUID()}/links`)).status).toBe(404)
  const letter = { text: 'Corrige o endereço de entrega informado.', attestation: true }
  expect((await send('POST', `/documents/${documentId}/correction-letters`, letter)).status).toBe(
    403,
  )
  role = 'issuer'
  expect(
    (
      await send('POST', `/documents/${documentId}/correction-letters`, {
        ...letter,
        attestation: false,
      })
    ).status,
  ).toBe(422)
  nextLetter = async () => ({ letterId: randomUUID(), sequence: 1, existing: false })
  const queued = await send('POST', `/documents/${documentId}/correction-letters`, letter)
  expect(queued.status).toBe(202)
  expect(await queued.json()).toMatchObject({ sequence: 1, simulated: true })
  nextLetter = async () => {
    throw new CorrectionLetterError('A correction letter needs an authorized NF-e')
  }
  const refused = await send('POST', `/documents/${documentId}/correction-letters`, letter)
  expect(refused.status).toBe(409)
  expect(await refused.json()).toMatchObject({ code: 'CORRECTION_NOT_ALLOWED' })
})
