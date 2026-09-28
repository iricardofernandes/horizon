import { describe, expect, it } from 'vitest'
import { EMPTY_METRICS, recordRun, renderMetrics } from './metrics'
import { type Http, type HttpAnswer, type HttpRequest, runProbe } from './probe'

const TENANT = '01a0b6b8-c334-7136-8144-e48a7ba17e08'
const ORDER = '01a0e33a-312b-7e6a-b71c-afb7794ae97d'
const DRAFT = '01a0e9a4-0000-7000-8000-000000000001'
const FAMILY = '01a0e9a4-ac72-73a2-917d-859d451d0064'

const answers: Record<string, HttpAnswer> = {
  'POST /auth/login': {
    status: 200,
    body: { selectionToken: 'selection', workspaces: [{ tenantId: TENANT }] },
  },
  'POST /auth/workspace': { status: 200, body: { accessToken: 'access', familyId: FAMILY } },
  'GET /reporting/dashboard': { status: 200, body: { cards: [] } },
  'GET /procurement/orders?limit=1': { status: 200, body: { data: [{ id: ORDER }] } },
  [`GET /procurement/orders/${ORDER}`]: {
    status: 200,
    body: {
      supplierId: '01a0b6b8-c6ab-7f93-ae1d-f0c808652441',
      warehouseId: 'b0c2206a-1008-4827-aa0b-a4cfd30768c1',
      currency: 'BRL',
      data: [{ itemId: '01a0b6b8-c367-7087-920c-1f2edc092004' }],
    },
  },
  'POST /procurement/orders': { status: 201, body: { id: DRAFT } },
  [`POST /procurement/orders/${DRAFT}/cancel`]: { status: 200, body: {} },
  'POST /auth/logout': { status: 204, body: null },
}

function fakeHttp(overrides: Record<string, HttpAnswer | Error> = {}) {
  const calls: Array<{ key: string; request: HttpRequest }> = []
  const http: Http = async (path, request = {}) => {
    const key = `${request.method ?? 'GET'} ${path}`
    calls.push({ key, request })
    const answer = overrides[key] ?? answers[key]
    if (answer instanceof Error) throw answer
    return answer ?? { status: 404, body: null }
  }
  return { http, calls }
}

const dependencies = (http: Http) => {
  let clock = Date.parse('2026-09-28T12:00:00.000Z')
  let id = 0
  return {
    http,
    now: () => {
      clock += 250
      return clock
    },
    newId: () => `01a0e9a4-0000-7000-8000-${String(++id).padStart(12, '0')}`,
  }
}

const config = { email: 'probe@horizon.local', password: 'probe-password-local' }

describe('runProbe', () => {
  it('signs in, reads the dashboard, drafts and cancels an order, and signs out', async () => {
    const { http, calls } = fakeHttp()
    const run = await runProbe(dependencies(http), config)
    expect(run).toMatchObject({ ok: true, failure: null })
    expect(run.steps.map((step) => [step.step, step.ok])).toEqual([
      ['login', true],
      ['dashboard', true],
      ['draft', true],
      ['cancel', true],
      ['logout', true],
    ])
    const draft = calls.find((call) => call.key === 'POST /procurement/orders')?.request
    expect(draft?.bearer).toBe('access')
    expect(draft?.idempotencyKey).toBeDefined()
    expect(draft?.body).toMatchObject({
      supplierId: '01a0b6b8-c6ab-7f93-ae1d-f0c808652441',
      warehouseId: 'b0c2206a-1008-4827-aa0b-a4cfd30768c1',
      issuedOn: '2026-09-28',
      notes: expect.stringMatching(/^PROBE-2026-09-28/),
      lines: [expect.objectContaining({ itemId: '01a0b6b8-c367-7087-920c-1f2edc092004' })],
    })
    expect(calls.at(-1)?.request.body).toEqual({ familyId: FAMILY })
  })

  it('names the failing step and its status, and still signs out', async () => {
    const { http, calls } = fakeHttp({
      'GET /reporting/dashboard': { status: 503, body: { title: 'Service Unavailable' } },
    })
    const run = await runProbe(dependencies(http), config)
    expect(run.ok).toBe(false)
    expect(run.failure).toEqual({ step: 'dashboard', status: 503, detail: 'answered 503' })
    expect(run.steps.map((step) => step.step)).toEqual(['login', 'dashboard', 'logout'])
    expect(calls.some((call) => call.key === 'POST /procurement/orders')).toBe(false)
  })

  it('reports an unreachable gateway on login without trying to sign out', async () => {
    const { http, calls } = fakeHttp({ 'POST /auth/login': new TypeError('fetch failed') })
    const run = await runProbe(dependencies(http), config)
    expect(run.failure).toMatchObject({ step: 'login', status: null })
    expect(run.failure?.detail).toMatch(/fetch failed/)
    expect(calls).toHaveLength(1)
  })

  it('refuses a workspace the account cannot enter', async () => {
    const { http } = fakeHttp()
    const run = await runProbe(dependencies(http), {
      ...config,
      tenantId: '01a0c5f8-798b-721e-912e-9b505406e614',
    })
    expect(run.failure).toMatchObject({ step: 'login', status: 200 })
  })

  it('fails the draft on a body it does not recognise', async () => {
    const { http } = fakeHttp({ 'POST /procurement/orders': { status: 201, body: {} } })
    const run = await runProbe(dependencies(http), config)
    expect(run.failure).toEqual({
      step: 'draft',
      status: 201,
      detail: 'answered an unexpected body',
    })
  })

  it('keeps the first failure when signing out also fails', async () => {
    const { http } = fakeHttp({
      [`POST /procurement/orders/${DRAFT}/cancel`]: { status: 409, body: {} },
      'POST /auth/logout': { status: 500, body: {} },
    })
    const run = await runProbe(dependencies(http), config)
    expect(run.failure?.step).toBe('cancel')
    expect(run.steps.at(-1)).toMatchObject({ step: 'logout', ok: false, status: 500 })
  })
})

describe('metrics', () => {
  it('count runs by outcome and keep the latest success', async () => {
    const good = await runProbe(dependencies(fakeHttp().http), config)
    const bad = await runProbe(
      dependencies(fakeHttp({ 'POST /auth/login': { status: 502, body: null } }).http),
      config,
    )
    const once = recordRun(EMPTY_METRICS, good, 1_000_000)
    const twice = recordRun(once, bad, 1_060_000)
    expect(EMPTY_METRICS.runs).toEqual({ success: 0, failure: 0 })
    expect(twice.runs).toEqual({ success: 1, failure: 1 })
    expect(twice.lastSuccessSeconds).toBe(1000)
    const text = renderMetrics(twice)
    expect(text).toContain('horizon_probe_runs_total{outcome="success"} 1')
    expect(text).toContain('horizon_probe_runs_total{outcome="failure"} 1')
    expect(text).toContain('horizon_probe_step_seconds{step="cancel"} 0.25')
    expect(text).toContain('horizon_probe_last_success_timestamp_seconds 1000')
  })

  it('leave the last success out until there is one', () => {
    expect(renderMetrics(EMPTY_METRICS)).not.toContain('last_success')
  })
})
