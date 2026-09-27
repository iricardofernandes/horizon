import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createFiscalServer, type FiscalServerDependencies } from '../api'
import type { FiscalPrincipal } from '../auth'
import type { ServiceDependencies } from './api'
import {
  MunicipalityUnsupported,
  ServiceCancellationWindowElapsed,
  SourceKeyConflict,
  SubstitutionNotAllowed,
} from './errors'

const tenantId = randomUUID()
const documentId = randomUUID()
const serviceOriginId = randomUUID()
let role: FiscalPrincipal['role'] = 'admin'
let originFailure: Error | null = null
let substitutionFailure: Error | null = null
let cancellationFailure: Error | null = null
let lastSubstitution: unknown

const document = {
  id: documentId,
  rootDocumentId: documentId,
  predecessorDocumentId: null,
  revision: 1,
  serviceOriginId,
  substitutesDocumentId: null,
  substitutedByDocumentId: null,
  status: 'authorized' as const,
  model: 'nfse' as const,
  environment: 'simulation' as const,
  simulated: true as const,
  fiscalValue: false as const,
  establishmentId: randomUUID(),
  municipalityCode: '3550308',
  competenceDate: '2026-09-01',
  series: 1,
  number: 1,
  dpsId: `DPS35503082${'1'.repeat(14)}00001000000000000001`,
  nfseKey: '3'.repeat(50),
  nfseNumber: '1',
  generatedAt: '2026-09-26T13:00:00.000Z',
  snapshotDigest: 'a'.repeat(64),
  calculationDigest: 'b'.repeat(64),
  dpsXmlDigest: 'c'.repeat(64),
  adapterVersion: 'nfse-national-simulator-v1',
  statusUrl: `/fiscal/service-documents/${documentId}`,
  createdAt: '2026-09-26T12:00:00.000Z',
}

let lastPolicy: unknown = null
let lastIntakeFilter: unknown = null
const blockedIntakeId = randomUUID()

const service: ServiceDependencies = {
  profiles: {
    async create() {
      throw new Error('unused')
    },
    async list() {
      return []
    },
  },
  registry: {
    async importVersion() {
      throw new Error('unused')
    },
    async review() {
      throw new Error('unused')
    },
    async resolve(_tenant, municipalityCode, competenceDate) {
      return {
        municipalityCode,
        competenceDate,
        route: 'unsupported',
        reason: 'The municipality does not use the national public issuer (E0039)',
        versionId: null,
        entry: null,
      }
    },
  },
  origins: {
    async create() {
      if (originFailure) throw originFailure
      return {
        id: serviceOriginId,
        digest: 'd'.repeat(64),
        createdAt: document.createdAt,
        existing: false,
      }
    },
  },
  documents: {
    async createDraft() {
      return { id: documentId, status: 'draft', snapshotDigest: 'a'.repeat(64), existing: false }
    },
    async get(requestedTenant, requestedDocument) {
      return requestedTenant === tenantId && requestedDocument === documentId ? document : null
    },
  },
  readiness: {
    async validate() {
      throw new MunicipalityUnsupported('The competence date precedes the agreement start (E0016)')
    },
  },
  policies: {
    async read(_tenant, establishmentId) {
      return {
        establishmentId,
        mode: 'review',
        series: 1,
        configured: false,
        updatedBy: null,
        updatedAt: null,
      }
    },
    async set(input) {
      lastPolicy = input
      return {
        establishmentId: input.establishmentId,
        mode: input.request.mode,
        series: input.request.series,
        configured: true,
        updatedBy: input.actorId,
        updatedAt: '2026-09-26T12:00:00.000Z',
      }
    },
  },
  intakes: {
    async list(_tenant, filter) {
      lastIntakeFilter = filter
      return []
    },
    async retry(_tenant, intakeId) {
      if (intakeId !== blockedIntakeId) throw new Error('Fiscal service intake is not blocked')
      throw new Error('unused')
    },
  },
  cancellation: {
    async request() {
      if (cancellationFailure) throw cancellationFailure
      return {
        commandId: randomUUID(),
        documentId,
        status: 'cancellation_pending',
        statusUrl: document.statusUrl,
        simulated: true as const,
        existing: false,
      }
    },
  },
  substitutions: {
    async request(input) {
      lastSubstitution = input
      if (substitutionFailure) throw substitutionFailure
      return { id: randomUUID(), status: 'draft', snapshotDigest: 'e'.repeat(64), existing: false }
    },
  },
}

const unused = async () => {
  throw new Error('unused')
}
const server = createFiscalServer({
  verifier: {
    async verify(authorization: string | undefined) {
      if (authorization !== 'Bearer test') throw new Error('Invalid token')
      return { tenantId, subject: 'user:reviewer', role }
    },
  },
  documents: {
    get: unused,
    timeline: unused,
    createDraft: unused,
    createManualDraft: unused,
    createSuccessor: unused,
    createManualSuccessor: unused,
  },
  manualOrigins: { create: unused },
  artifacts: { get: unused, getV2: unused, list: unused, listV2: unused },
  calculations: { preview: unused, get: unused },
  capabilities: { listActive: async () => [] },
  readiness: { validate: unused },
  rules: { proposeOverride: unused },
  service,
} as unknown as FiscalServerDependencies)
let base = ''

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function call(method: string, path: string, body?: unknown, key = `phase47-${randomUUID()}`) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: 'Bearer test',
      'content-type': 'application/json',
      'idempotency-key': key,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

const originRequest = {
  establishmentId: randomUUID(),
  issuerProfileRevision: 1,
  recipientPartyId: randomUUID(),
  recipientProfileRevision: 1,
  serviceItemId: randomUUID(),
  serviceProfileRevision: 1,
  competenceDate: '2026-09-01',
  amount: { amount: '150000', currency: 'BRL' },
  description: 'Desenvolvimento de sistema sob medida',
  reason: 'Serviço prestado e revisado pelo emissor',
}

it('freezes a service origin and answers stable codes for refused facts', async () => {
  role = 'issuer'
  expect((await call('POST', '/service-origins', originRequest)).status).toBe(201)
  originFailure = new SourceKeyConflict('The source key was already frozen with different facts')
  const conflict = await call('POST', '/service-origins', originRequest)
  expect(conflict.status).toBe(409)
  expect(await conflict.json()).toMatchObject({ code: 'SOURCE_KEY_CONFLICT' })
  originFailure = new MunicipalityUnsupported('The municipality does not use the national issuer')
  expect(await (await call('POST', '/service-origins', originRequest)).json()).toMatchObject({
    code: 'MUNICIPALITY_UNSUPPORTED',
  })
  originFailure = null
  expect((await call('POST', '/service-origins', { ...originRequest, amount: 1 })).status).toBe(400)
})

it('keeps registry and profile changes to administrators', async () => {
  role = 'issuer'
  expect(
    (await call('POST', '/nfse-registry/versions', { sourceUri: 'https://x', entries: [] })).status,
  ).toBe(403)
  expect((await call('POST', '/service-profiles', {})).status).toBe(403)
  role = 'viewer'
  const resolved = await call(
    'GET',
    '/nfse-registry/municipalities/3509502?competenceDate=2026-09-01',
  )
  expect(await resolved.json()).toMatchObject({ route: 'unsupported', municipalityCode: '3509502' })
})

it('reads NFS-e documents and maps readiness refusals', async () => {
  role = 'viewer'
  const read = await call('GET', `/service-documents/${documentId}`)
  expect(read.status).toBe(200)
  expect(await read.json()).toMatchObject({ model: 'nfse', nfseNumber: '1', fiscalValue: false })
  expect((await call('GET', `/service-documents/${randomUUID()}`)).status).toBe(404)
  expect((await call('POST', `/service-documents/${documentId}/validate`)).status).toBe(403)
  role = 'issuer'
  const refused = await call('POST', `/service-documents/${documentId}/validate`)
  expect(refused.status).toBe(409)
  expect(await refused.json()).toMatchObject({ code: 'MUNICIPALITY_UNSUPPORTED' })
})

it('queues cancellations and substitutions with their reason codes', async () => {
  role = 'issuer'
  const cancellation = await call(
    'POST',
    `/service-documents/${documentId}/cancellation-requests`,
    {
      reasonCode: '2',
      reason: 'Serviço não foi prestado ao cliente',
    },
  )
  expect(cancellation.status).toBe(202)
  cancellationFailure = new ServiceCancellationWindowElapsed(30)
  const late = await call('POST', `/service-documents/${documentId}/cancellation-requests`, {
    reasonCode: '2',
    reason: 'Serviço não foi prestado ao cliente',
  })
  expect(await late.json()).toMatchObject({ code: 'CANCELLATION_WINDOW_ELAPSED' })
  cancellationFailure = null
  const correctedOrigin = { serviceOriginId: randomUUID() }
  expect(
    (
      await call('POST', `/service-documents/${documentId}/substitutions`, {
        reasonCode: '99',
        correctedOrigin,
      })
    ).status,
  ).toBe(400)
  const created = await call('POST', `/service-documents/${documentId}/substitutions`, {
    reasonCode: '01',
    correctedOrigin,
  })
  expect(created.status).toBe(201)
  expect(lastSubstitution).toMatchObject({
    reasonCode: '01',
    reason: null,
    correctedServiceOriginId: correctedOrigin.serviceOriginId,
  })
  substitutionFailure = new SubstitutionNotAllowed('The NFS-e was already substituted')
  const refused = await call('POST', `/service-documents/${documentId}/substitutions`, {
    reasonCode: '01',
    correctedOrigin,
  })
  expect(await refused.json()).toMatchObject({ code: 'SUBSTITUTION_NOT_ALLOWED' })
  role = 'viewer'
  expect(
    (
      await call('POST', `/service-documents/${documentId}/substitutions`, {
        reasonCode: '01',
        correctedOrigin,
      })
    ).status,
  ).toBe(403)
})

it('keeps the issuance policy to administrators and lists delivered services', async () => {
  const establishmentId = randomUUID()
  role = 'viewer'
  const current = await call('GET', `/service-issuance-policies/${establishmentId}`)
  expect(await current.json()).toMatchObject({ mode: 'review', series: 1, configured: false })
  const policy = {
    mode: 'automatic',
    series: 2,
    reason: 'Emissão automática revisada pela contabilidade',
  }
  expect((await call('PUT', `/service-issuance-policies/${establishmentId}`, policy)).status).toBe(
    403,
  )
  role = 'admin'
  const saved = await call('PUT', `/service-issuance-policies/${establishmentId}`, policy)
  expect(saved.status).toBe(200)
  expect(await saved.json()).toMatchObject({ mode: 'automatic', series: 2, configured: true })
  expect(lastPolicy).toMatchObject({ establishmentId, actorId: 'user:reviewer' })
  expect(
    (await call('PUT', `/service-issuance-policies/${establishmentId}`, { ...policy, series: 0 }))
      .status,
  ).toBe(400)

  role = 'viewer'
  const listed = await call('GET', '/service-intakes?status=blocked')
  expect(await listed.json()).toEqual({ data: [] })
  expect(lastIntakeFilter).toEqual({ status: 'blocked' })
  expect((await call('GET', '/service-intakes?status=lost')).status).toBe(400)
  expect((await call('POST', `/service-intakes/${randomUUID()}/retry`)).status).toBe(403)
  role = 'issuer'
  const retried = await call('POST', `/service-intakes/${randomUUID()}/retry`)
  expect(retried.status).toBe(409)
  expect(await retried.json()).toMatchObject({ code: 'INVALID_STATE_TRANSITION' })
})
