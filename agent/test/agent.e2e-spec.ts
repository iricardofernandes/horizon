import { randomBytes, randomUUID } from 'node:crypto'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import postgres from 'postgres'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AppModule } from '@/main/app.module'
import { readEnvironment } from '@/main/environment'
import { FakeGateway, type TestKey } from './support/fake-gateway'

let app: INestApplication
let gateway: FakeGateway

const alnum = (length: number) =>
  randomBytes(length * 2)
    .toString('base64')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, length)

function key(tenantId: string, scopes: readonly string[]): TestKey {
  return {
    secret: `hz_test_${alnum(24)}_${alnum(32)}`,
    tenantId,
    apiKeyId: randomUUID(),
    issuer: randomUUID(),
    scopes,
    roles: [
      { module: 'parties', role: 'viewer' },
      { module: 'sales', role: 'viewer' },
    ],
  }
}

beforeAll(async () => {
  gateway = await FakeGateway.start()
  const parties = Array.from({ length: 80 }, (_, index) => ({
    id: randomUUID(),
    legalName: `P${index}`,
  }))
  gateway.route('/parties/parties', () => ({ status: 200, body: { data: parties } }))
  gateway.route('/sales/orders', () => ({ status: 200, body: [] }))
  const config = readEnvironment({
    ...process.env,
    GATEWAY_URL: gateway.url,
    JWKS_URL: gateway.jwksUrl,
    AGENT_MAX_ROWS: '50',
  })
  const module = await Test.createTestingModule({ imports: [AppModule.register(config)] }).compile()
  app = module.createNestApplication({ logger: false })
  await app.init()
})

afterAll(async () => {
  await app?.close()
  await gateway?.stop()
})

const owner = (tenantId: string) =>
  gateway.person(tenantId, [{ module: 'identity', role: 'owner' }])

async function enable(tenantId: string, enabled = true) {
  await request(app.getHttpServer())
    .put('/settings')
    .set('authorization', `Bearer ${await owner(tenantId)}`)
    .send({ enabled })
    .expect(200)
}

let rpcId = 0
function mcp(tenantId: string, secret: string, method: string, params: object = {}) {
  rpcId += 1
  return request(app.getHttpServer())
    .post(`/tenants/${tenantId}/mcp`)
    .set('authorization', `Bearer ${secret}`)
    .set('accept', 'application/json, text/event-stream')
    .send({ jsonrpc: '2.0', id: rpcId, method, params })
}

const initialize = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'phase72-e2e', version: '1.0.0' },
}

describe('the order of checks', () => {
  it('refuses before any exchange while agent access is off', async () => {
    const tenantId = randomUUID()
    const agentKey = key(tenantId, ['agent:connect', 'parties:read'])
    gateway.addKey(agentKey)
    const before = gateway.exchanges
    const refused = await mcp(tenantId, agentKey.secret, 'initialize', initialize).expect(403)
    expect(refused.body.type).toBe('https://horizon.dev/problems/agent-access-off')
    expect(gateway.exchanges).toBe(before)
  })

  it('refuses a credential that is not an API key, without an exchange', async () => {
    const before = gateway.exchanges
    await mcp(randomUUID(), 'not-a-key', 'initialize', initialize).expect(401)
    expect(gateway.exchanges).toBe(before)
  })

  it('refuses a key without agent:connect, and a key sent to another tenant', async () => {
    const tenantId = randomUUID()
    const other = randomUUID()
    await Promise.all([enable(tenantId), enable(other)])
    const noConnect = key(tenantId, ['parties:read'])
    const agentKey = key(tenantId, ['agent:connect', 'parties:read'])
    gateway.addKey(noConnect)
    gateway.addKey(agentKey)
    const missing = await mcp(tenantId, noConnect.secret, 'initialize', initialize).expect(403)
    expect(missing.body.type).toBe('https://horizon.dev/problems/agent-connect-missing')
    // The URL names the tenant, but the key is looked up inside it: another's is unknown.
    const forged = await mcp(other, agentKey.secret, 'tools/call', {
      name: 'list_parties',
      arguments: {},
    }).expect(401)
    expect(JSON.stringify(forged.body)).not.toContain('legalName')
  })

  it('answers 405 to anything but POST', async () => {
    await request(app.getHttpServer()).get(`/tenants/${randomUUID()}/mcp`).expect(405)
  })
})

describe('an admitted agent', () => {
  let tenantId: string
  let agentKey: TestKey

  beforeAll(async () => {
    tenantId = randomUUID()
    await enable(tenantId)
    agentKey = key(tenantId, ['agent:connect', 'parties:read'])
    gateway.addKey(agentKey)
  })

  it('initializes and lists only the tools its scopes reach', async () => {
    const initialized = await mcp(tenantId, agentKey.secret, 'initialize', initialize).expect(200)
    expect(initialized.body.result.serverInfo.name).toBe('horizon-agent')
    const listed = await mcp(tenantId, agentKey.secret, 'tools/list').expect(200)
    const names = listed.body.result.tools.map((tool: { name: string }) => tool.name)
    expect(names.sort()).toEqual(['get_party', 'list_parties'])
    for (const tool of listed.body.result.tools) expect(tool.annotations.readOnlyHint).toBe(true)
  })

  it('reads through the gateway with the key token, capped at the row limit', async () => {
    const called = await mcp(tenantId, agentKey.secret, 'tools/call', {
      name: 'list_parties',
      arguments: { search: 'Maria Silva', limit: 200 },
    }).expect(200)
    const result = JSON.parse(called.body.result.content[0].text)
    expect(result.truncated).toBe(true)
    expect(result.result.data).toHaveLength(50)
    const read = gateway.reads.at(-1)
    expect(read?.query).toContain('limit=50')
    expect(read?.query).toContain('search=Maria+Silva')
  })

  it('refuses a tool outside its scopes by name, and never reaches the gateway for it', async () => {
    const reads = gateway.reads.length
    const called = await mcp(tenantId, agentKey.secret, 'tools/call', {
      name: 'list_sales_orders',
      arguments: {},
    }).expect(200)
    expect(called.body.result.isError).toBe(true)
    expect(gateway.reads.length).toBe(reads)
  })

  it('publishes each tool input as a closed JSON schema', async () => {
    const listed = await mcp(tenantId, agentKey.secret, 'tools/list').expect(200)
    const get = listed.body.result.tools.find((tool: { name: string }) => tool.name === 'get_party')
    expect(get.inputSchema).toMatchObject({
      type: 'object',
      required: ['id'],
      additionalProperties: false,
    })
  })

  it('audits every call without its arguments, and the chain holds', async () => {
    const page = await request(app.getHttpServer())
      .get('/audit')
      .query({ action: 'agent.tool.called', limit: 50 })
      .set('authorization', `Bearer ${await owner(tenantId)}`)
      .expect(200)
    expect(page.body.chain.status).toBe('intact')
    const entries = page.body.data
    expect(entries.length).toBeGreaterThanOrEqual(1)
    const listCall = entries.find(
      (entry: { subjectId: string }) => entry.subjectId === 'list_parties',
    )
    expect(listCall).toMatchObject({
      actor: `api-key:${agentKey.apiKeyId}`,
      details: { issuer: agentKey.issuer, outcome: 'ok', rows: 50, truncated: true },
    })
    expect(listCall.details.argumentsDigest).toMatch(/^[0-9a-f]{64}$/)
    // The attempt at a tool out of reach is in the log too, as refused.
    expect(
      entries.find((entry: { subjectId: string }) => entry.subjectId === 'list_sales_orders'),
    ).toMatchObject({ details: { outcome: 'refused', status: 403 } })
    expect(JSON.stringify(page.body)).not.toContain('Maria')
  })
})

describe('settings and the log', () => {
  it('lets only an Identity owner or admin switch access, never a key token', async () => {
    const tenantId = randomUUID()
    const member = await gateway.person(tenantId, [{ module: 'identity', role: 'member' }])
    await request(app.getHttpServer())
      .put('/settings')
      .set('authorization', `Bearer ${member}`)
      .send({ enabled: true })
      .expect(403)
    const agentKey = key(tenantId, ['agent:connect', 'identity:read'])
    gateway.addKey(agentKey)
    const exchanged = await fetch(`${gateway.url}/auth/api-key/token`, {
      method: 'POST',
      body: JSON.stringify({ tenantId, presented: agentKey.secret }),
    }).then((response) => response.json() as Promise<{ accessToken: string }>)
    await request(app.getHttpServer())
      .get('/settings')
      .set('authorization', `Bearer ${exchanged.accessToken}`)
      .expect(403)
    const admin = await gateway.person(tenantId, [{ module: 'identity', role: 'admin' }])
    const switched = await request(app.getHttpServer())
      .put('/settings')
      .set('authorization', `Bearer ${admin}`)
      .send({ enabled: true })
      .expect(200)
    expect(switched.body.enabled).toBe(true)
  })

  it('keeps each workspace to its own log, and the log append-only', async () => {
    const first = randomUUID()
    const second = randomUUID()
    await enable(first)
    const page = await request(app.getHttpServer())
      .get('/audit')
      .set('authorization', `Bearer ${await owner(second)}`)
      .expect(200)
    expect(page.body.data).toEqual([])
    const sql = postgres(process.env.DATABASE_URL ?? '', { max: 1 })
    try {
      await expect(
        sql.begin(async (tx) => {
          await tx`select set_config('app.current_tenant', ${first}, true)`
          await tx`update audit_log set action = 'x'`
        }),
      ).rejects.toThrow(/append-only|permission denied/)
    } finally {
      await sql.end()
    }
  })
})

describe('drafts (ADR 0066)', () => {
  it('drafts once per request, audits what it created, and lists it for the module', async () => {
    const tenantId = randomUUID()
    await enable(tenantId)
    const writer = key(tenantId, ['agent:connect', 'procurement:write'])
    gateway.addKey(writer)
    const requisition = {
      name: 'draft_purchase_requisition',
      arguments: {
        warehouseId: randomUUID(),
        neededBy: '2026-12-31',
        lines: [{ itemId: randomUUID(), quantity: '4' }],
      },
    }
    const call = (id: number) =>
      request(app.getHttpServer())
        .post(`/tenants/${tenantId}/mcp`)
        .set('authorization', `Bearer ${writer.secret}`)
        .set('accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id, method: 'tools/call', params: requisition })
        .expect(200)
    const first = await call(9001)
    const retried = await call(9001)
    const created = JSON.parse(first.body.result.content[0].text).result.id
    expect(JSON.parse(retried.body.result.content[0].text).result.id).toBe(created)
    const posted = gateway.writes.filter((write) => write.path === '/procurement/requisitions')
    expect(posted.at(-1)?.key).toBe(posted.at(-2)?.key)

    const buyer = await gateway.person(tenantId, [{ module: 'procurement', role: 'buyer' }])
    const drafts = await request(app.getHttpServer())
      .get('/drafts')
      .query({ module: 'procurement', type: 'requisition' })
      .set('authorization', `Bearer ${buyer}`)
      .expect(200)
    expect(drafts.body.data.map((draft: { recordId: string }) => draft.recordId)).toContain(created)
    expect(drafts.body.data[0]).toMatchObject({ keyId: writer.apiKeyId, type: 'requisition' })

    const outsider = await gateway.person(tenantId, [{ module: 'sales', role: 'admin' }])
    await request(app.getHttpServer())
      .get('/drafts')
      .query({ module: 'procurement' })
      .set('authorization', `Bearer ${outsider}`)
      .expect(403)
  })

  it('lists no draft tool to a key that only reads', async () => {
    const tenantId = randomUUID()
    await enable(tenantId)
    const reader = key(tenantId, ['agent:connect', 'procurement:read'])
    gateway.addKey(reader)
    const listed = await mcp(tenantId, reader.secret, 'tools/list').expect(200)
    const names: string[] = listed.body.result.tools.map((tool: { name: string }) => tool.name)
    expect(names).not.toContain('draft_purchase_requisition')
    const draft = listed.body.result.tools.find(
      (tool: { name: string }) => tool.name === 'list_requisitions',
    )
    expect(draft.annotations.readOnlyHint).toBe(true)
  })
})
