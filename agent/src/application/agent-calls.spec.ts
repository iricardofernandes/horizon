import { beforeEach, describe, expect, it } from 'vitest'
import { AgentCalls, type AgentSession, type KeyClaims, KeyTokens } from './agent-calls'
import {
  AgentStore,
  type AuditRecord,
  type CallMetrics,
  type ExchangedKey,
  type ExchangeRefusal,
  Gateway,
  type GatewayAnswer,
  KeyExchange,
} from './ports'

const tenantId = '00000000-0000-4000-8000-000000000001'

class FakeStore extends AgentStore {
  enabled = true
  failAudit = false
  readonly records: AuditRecord[] = []
  async accessEnabled() {
    return this.enabled
  }
  async setAccess() {}
  async audit(_tenant: string, record: AuditRecord) {
    if (this.failAudit) throw new Error('down')
    this.records.push(record)
  }
}

class FakeKeys extends KeyExchange {
  exchanges = 0
  answer: { ok: true; key: ExchangedKey } | { ok: false; refusal: ExchangeRefusal } = {
    ok: true,
    key: { apiKeyId: 'key-1', accessToken: 'token-1', scopes: [] },
  }
  async exchange() {
    this.exchanges += 1
    return this.answer
  }
}

class FakeTokens extends KeyTokens {
  claims: KeyClaims = { tenantId, scopes: ['agent:connect', 'parties:read'], keyIssuer: 'ana' }
  async read() {
    return this.claims
  }
}

class FakeGateway extends Gateway {
  readonly written: { path: string; body: Record<string, unknown>; key: string }[] = []
  async write(path: string, body: Readonly<Record<string, unknown>>, _token: string, key: string) {
    this.written.push({ path, body: { ...body }, key })
    return { status: 201, body: { id: `created-${this.written.length}` } }
  }
  readonly asked: { path: string; query: Record<string, string>; token: string }[] = []
  answer: GatewayAnswer | Error = { status: 200, body: { data: [{ id: 1 }, { id: 2 }, { id: 3 }] } }
  async read(path: string, query: Readonly<Record<string, string>>, token: string) {
    this.asked.push({ path, query: { ...query }, token })
    if (this.answer instanceof Error) throw this.answer
    return this.answer
  }
}

const recorded: { tool: string; outcome: string; seconds?: number }[] = []
const metrics: CallMetrics = {
  called: (record) => recorded.push(record),
  exchanged: () => undefined,
}

let store: FakeStore
let keys: FakeKeys
let tokens: FakeTokens
let gateway: FakeGateway
let calls: AgentCalls

beforeEach(() => {
  store = new FakeStore()
  keys = new FakeKeys()
  tokens = new FakeTokens()
  gateway = new FakeGateway()
  calls = new AgentCalls(store, keys, tokens, gateway, { now: () => new Date() }, metrics, {
    maxRows: 2,
    maxBytes: 10_000,
  })
})

async function session(): Promise<AgentSession> {
  const admission = await calls.admit(tenantId, 'hz_key')
  if (!admission.ok) throw new Error(admission.refusal.code)
  return admission.session
}

describe('admission', () => {
  it('refuses before any exchange when access is off', async () => {
    store.enabled = false
    const admission = await calls.admit(tenantId, 'hz_key')
    expect(admission).toMatchObject({
      ok: false,
      refusal: { status: 403, code: 'agent-access-off' },
    })
    expect(keys.exchanges).toBe(0)
  })

  it('passes an exchange refusal on with its status and wait', async () => {
    keys.answer = { ok: false, refusal: { status: 429, detail: 'slow down', retryAfterSeconds: 9 } }
    expect(await calls.admit(tenantId, 'hz_key')).toMatchObject({
      ok: false,
      refusal: { status: 429, retryAfterSeconds: 9 },
    })
  })

  it('refuses a key without agent:connect, and a token of another tenant', async () => {
    tokens.claims = { ...tokens.claims, scopes: ['parties:read'] }
    expect(await calls.admit(tenantId, 'hz_key')).toMatchObject({
      refusal: { status: 403, code: 'agent-connect-missing' },
    })
    tokens.claims = { ...tokens.claims, scopes: ['agent:connect'], tenantId: 'other' }
    expect(await calls.admit(tenantId, 'hz_key')).toMatchObject({ refusal: { status: 401 } })
  })

  it('admits with the key, its issuer and its verified scopes', async () => {
    expect(await session()).toMatchObject({
      apiKeyId: 'key-1',
      issuer: 'ana',
      accessToken: 'token-1',
    })
  })
})

describe('a call', () => {
  it('reads through the gateway with the key token, cuts to the cap and audits a digest', async () => {
    const answer = await calls.call(await session(), 'list_parties', { search: 'Maria Silva' })
    expect(answer).toMatchObject({ isError: false, outcome: 'ok' })
    expect(JSON.parse(answer.text)).toEqual({
      truncated: true,
      result: { data: [{ id: 1 }, { id: 2 }] },
    })
    expect(gateway.asked).toEqual([
      { path: '/parties/parties', query: { search: 'Maria Silva', limit: '2' }, token: 'token-1' },
    ])
    const [record] = store.records
    expect(record).toMatchObject({
      actor: 'api-key:key-1',
      subjectId: 'list_parties',
      action: 'agent.tool.called',
      details: { issuer: 'ana', outcome: 'ok', status: 200, rows: 2, truncated: true },
    })
    expect(JSON.stringify(record)).not.toContain('Maria')
  })

  it('refuses a tool outside the key scopes without calling the gateway, and audits it', async () => {
    const answer = await calls.call(await session(), 'list_sales_orders', {})
    expect(answer).toMatchObject({ isError: true, outcome: 'refused' })
    expect(gateway.asked).toEqual([])
    expect(store.records[0]).toMatchObject({ details: { outcome: 'refused', status: 403 } })
  })

  it('passes a module refusal on in its own words, and hides a failure', async () => {
    gateway.answer = {
      status: 403,
      body: { detail: 'The Parties role does not permit this operation' },
    }
    expect((await calls.call(await session(), 'list_parties', {})).text).toBe(
      'Horizon answered 403: The Parties role does not permit this operation',
    )
    gateway.answer = { status: 500, body: { detail: 'relation "x" does not exist' } }
    const failed = await calls.call(await session(), 'list_parties', {})
    expect(failed).toMatchObject({ isError: true, outcome: 'failed' })
    expect(failed.text).not.toContain('relation')
    gateway.answer = new Error('ECONNREFUSED')
    expect(await calls.call(await session(), 'list_parties', {})).toMatchObject({
      outcome: 'failed',
    })
  })

  it('returns no data when the call cannot be audited', async () => {
    store.failAudit = true
    const answer = await calls.call(await session(), 'list_parties', {})
    expect(answer).toMatchObject({ isError: true, outcome: 'failed' })
    expect(answer.text).not.toContain('"id"')
  })
})

describe('arguments', () => {
  it('refuses an argument the tool does not declare, audited, without reaching the gateway', async () => {
    const answer = await calls.call(await session(), 'list_parties', { path: '/sales/orders' })
    expect(answer).toMatchObject({ isError: true, outcome: 'refused' })
    expect(answer.text).toContain('Invalid arguments')
    expect(gateway.asked).toEqual([])
    expect(store.records[0]).toMatchObject({ details: { outcome: 'refused', status: 400 } })
  })
})

describe('drafts (ADR 0066)', () => {
  const requisition = {
    warehouseId: '00000000-0000-4000-8000-0000000000aa',
    neededBy: '2026-12-31',
    lines: [{ itemId: '00000000-0000-4000-8000-0000000000bb', quantity: '3' }],
  }

  beforeEach(() => {
    tokens.claims = { ...tokens.claims, scopes: ['agent:connect', 'procurement:write'] }
  })

  it('writes a draft with a key that is the same for the same request, and new for another', async () => {
    const admitted = await session()
    await calls.call(admitted, 'draft_purchase_requisition', requisition, 7)
    await calls.call(admitted, 'draft_purchase_requisition', requisition, 7)
    await calls.call(admitted, 'draft_purchase_requisition', requisition, 8)
    const [first, retried, other] = gateway.written
    expect(first?.path).toBe('/procurement/requisitions')
    expect(first?.key).toMatch(/^agent-[0-9a-f]{48}$/)
    expect(retried?.key).toBe(first?.key)
    expect(retried?.body).toEqual(first?.body)
    expect(other?.key).not.toBe(first?.key)
    const lines = (first?.body.lines ?? []) as { lineId: string }[]
    const lineId = lines[0]?.lineId
    expect(lineId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('records what the draft created in the audit', async () => {
    await calls.call(await session(), 'draft_purchase_requisition', requisition, 1)
    expect(store.records.at(-1)).toMatchObject({
      subjectId: 'draft_purchase_requisition',
      details: {
        outcome: 'ok',
        record: { module: 'procurement', type: 'requisition', id: 'created-1' },
      },
    })
  })

  it('offers no draft tool to a key that only reads the module', async () => {
    tokens.claims = { ...tokens.claims, scopes: ['agent:connect', 'procurement:read'] }
    const answer = await calls.call(await session(), 'draft_purchase_requisition', requisition, 1)
    expect(answer).toMatchObject({ isError: true, outcome: 'refused' })
    expect(gateway.written).toEqual([])
  })

  it('assigns a task to the key issuer unless another person is named', async () => {
    tokens.claims = {
      ...tokens.claims,
      scopes: ['agent:connect', 'crm:write'],
      keyIssuer: 'ana-uuid',
    }
    const task = {
      subject: { type: 'account', id: '00000000-0000-4000-8000-0000000000cc' },
      title: 'Call back',
      dueAt: '2026-10-01T12:00:00Z',
    }
    await calls.call(await session(), 'create_crm_task', task, 1)
    expect(gateway.written.at(-1)?.body.assigneeId).toBe('ana-uuid')
  })
})

describe('the MCP latency SLI (Phase 78)', () => {
  it('records how long each call took, refused or answered', async () => {
    recorded.length = 0
    const opened = await session()
    await calls.call(opened, 'list_parties', {})
    await calls.call(opened, 'post_payable', {})
    expect(recorded.map((record) => record.outcome)).toEqual(['ok', 'refused'])
    for (const record of recorded) expect(record.seconds).toBeGreaterThanOrEqual(0)
  })
})
