import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createFiscalServer, type FiscalServerDependencies } from './api'
import type { FiscalPrincipal } from './auth'
import { rejectionLabel } from './metrics'
import { CERTIFICATE_WARNING_DAYS, certificateState } from './support'

const tenantId = randomUUID()
const role: FiscalPrincipal['role'] = 'viewer'
let lastQuery: unknown

const unused = async () => {
  throw new Error('unused')
}
const server = createFiscalServer({
  verifier: {
    async verify(authorization: string | undefined) {
      if (authorization !== 'Bearer test') throw new Error('Invalid token')
      return { tenantId, subject: 'user:operator', role }
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
  documentList: {
    async list(requestedTenant: string, query: Record<string, unknown>) {
      lastQuery = { requestedTenant, ...query }
      return { data: [], page: { hasMore: false } }
    },
  },
  support: {
    async overview(requestedTenant: string) {
      return {
        generatedAt: '2026-09-26T21:00:00.000Z',
        simulationOnly: true,
        queue: { pending: 0, leased: 0, oldestDueSeconds: 0, maxAttemptCount: 0 },
        documents: {},
        unknownOutcomes: requestedTenant === tenantId ? 0 : 99,
        rejections: [],
        certificates: [],
        imports: { open: 0, blocked: 0, reconciled: 0 },
        outbox: { undelivered: 0, oldestUndeliveredSeconds: 0 },
        capabilities: [],
        sourcePackages: [],
      }
    },
  },
} as unknown as FiscalServerDependencies)
let base = ''

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const get = (path: string) => fetch(`${base}${path}`, { headers: { authorization: 'Bearer test' } })

describe('Phase 48 support routes', () => {
  it('lists the worklist of the caller tenant with a validated query', async () => {
    const listed = await get('/documents?status=unknown&model=nfse&limit=10')
    expect(listed.status).toBe(200)
    expect(listed.headers.get('cache-control')).toBe('private, no-store')
    expect(lastQuery).toEqual({
      requestedTenant: tenantId,
      status: 'unknown',
      model: 'nfse',
      limit: 10,
    })
    expect((await get('/documents?status=approved')).status).toBe(400)
    expect((await get('/documents?limit=101')).status).toBe(400)
    expect((await get('/documents?tenantId=other')).status).toBe(400)
  })

  it('answers the support overview of the caller tenant only', async () => {
    const overview = await get('/support/overview')
    expect(overview.status).toBe(200)
    expect(await overview.json()).toMatchObject({ unknownOutcomes: 0, simulationOnly: true })
    const anonymous = await fetch(`${base}/support/overview`)
    expect(anonymous.status).toBe(401)
  })
})

describe('Phase 48 support helpers', () => {
  it('classifies certificate expiry against the warning window', () => {
    const now = new Date('2026-09-26T12:00:00.000Z')
    const days = (value: number) => new Date(now.getTime() + value * 86_400_000)
    expect(certificateState(days(CERTIFICATE_WARNING_DAYS + 1), now)).toBe('valid')
    expect(certificateState(days(CERTIFICATE_WARNING_DAYS), now)).toBe('expiring')
    expect(certificateState(days(0.5), now)).toBe('expiring')
    expect(certificateState(now, now)).toBe('expired')
  })

  it('keeps metric labels bounded', () => {
    expect(rejectionLabel('E0014')).toBe('E0014')
    expect(rejectionLabel('SIMULATED_REJECTION')).toBe('SIMULATED_REJECTION')
    expect(rejectionLabel('539')).toBe('539')
    expect(rejectionLabel('Rejeição: CNPJ 12345678000195')).toBe('other')
    expect(rejectionLabel(null)).toBe('none')
  })
})
