import { randomUUID } from 'node:crypto'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import postgres from 'postgres'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NOTICE_VERSION } from '@/application/assistant'
import { AgentRuntime } from '@/main/agent-runtime'
import { AppModule } from '@/main/app.module'
import { readEnvironment } from '@/main/environment'
import { FakeGateway } from './support/fake-gateway'

/**
 * The assistant through HTTP (Phase 76): a real PostgreSQL with the unprivileged role, the
 * extractive generator, and a fake gateway that answers only tokens it minted.
 */
let gateway: FakeGateway
let app: INestApplication
let runtime: AgentRuntime
let administrator: postgres.Sql

const PARTY = { id: randomUUID(), legalName: 'Torrefação Aurora' }

beforeAll(async () => {
  gateway = await FakeGateway.start()
  gateway.route('/parties/parties', () => ({ status: 200, body: { data: [PARTY] } }))
  gateway.route('/knowledge/search', (query) => ({
    status: 200,
    body: {
      data: [
        {
          attachmentId: randomUUID(),
          record: { module: 'parties', recordType: 'party', recordId: PARTY.id },
          screen: '/app/registrations/parties',
          position: { chunk: 1, of: 1 },
          excerpt: `Contrato de fornecimento de café (${query.get('q')}).`,
        },
      ],
      searched: ['parties'],
    },
  }))
  const config = readEnvironment({
    ...process.env,
    GATEWAY_URL: gateway.url,
    JWKS_URL: gateway.jwksUrl,
    ASSISTANT_MASTER_KEY: 'ab'.repeat(32),
  })
  const module = await Test.createTestingModule({
    imports: [AppModule.register(config, {}, { background: false })],
  }).compile()
  app = module.createNestApplication({ logger: false })
  await app.init()
  runtime = app.get(AgentRuntime)
  administrator = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
})

afterAll(async () => {
  await app?.close()
  await gateway?.stop()
  await administrator?.end()
})

const OWNER = [{ module: 'identity', role: 'owner' }]
const READER = [{ module: 'parties', role: 'viewer' }]

async function turnOn(tenantId: string, budget?: number) {
  await request(app.getHttpServer())
    .put('/assistant/settings')
    .set('authorization', `Bearer ${await gateway.person(tenantId, OWNER)}`)
    .send({
      enabled: true,
      acceptNotice: NOTICE_VERSION,
      ...(budget ? { monthlyBudgetTokens: budget } : {}),
    })
    .expect(200)
}

async function ask(token: string, question: string, conversationId?: string) {
  return request(app.getHttpServer())
    .post('/assistant/questions')
    .set('authorization', `Bearer ${token}`)
    .send({ question, ...(conversationId ? { conversationId } : {}) })
}

describe('opting in (ADR 0069)', () => {
  it('is off by default: a question is refused, and nothing is spent or read', async () => {
    const tenantId = randomUUID()
    const reads = gateway.reads.length
    const token = await gateway.person(tenantId, READER)
    const refused = await ask(token, 'Quem é a Aurora?')
    expect(refused.status).toBe(403)
    expect(refused.body).toMatchObject({ code: 'assistant-off' })
    expect(gateway.reads.length).toBe(reads)
    const status = await request(app.getHttpServer())
      .get('/assistant/status')
      .set('authorization', `Bearer ${token}`)
      .expect(200)
    expect(status.body).toMatchObject({
      enabled: false,
      available: true,
      notice: { version: NOTICE_VERSION, accepted: false },
      budget: { monthlyTokens: 200_000, spentTokens: 0, questions: 0 },
    })
  })

  it('is turned on only by an owner accepting the current notice; an admin may turn it off', async () => {
    const tenantId = randomUUID()
    const admin = await gateway.person(tenantId, [{ module: 'identity', role: 'admin' }])
    const owner = await gateway.person(tenantId, OWNER)
    const put = (token: string, body: object) =>
      request(app.getHttpServer())
        .put('/assistant/settings')
        .set('authorization', `Bearer ${token}`)
        .send(body)
    expect((await put(admin, { enabled: true, acceptNotice: NOTICE_VERSION })).status).toBe(403)
    expect((await put(owner, { enabled: true })).status).toBe(403)
    expect((await put(owner, { enabled: true, acceptNotice: 'old' })).status).toBe(400)
    expect((await put(owner, { enabled: true, acceptNotice: NOTICE_VERSION })).body).toMatchObject({
      enabled: true,
      notice: { accepted: true },
    })
    expect((await put(admin, { enabled: false, monthlyBudgetTokens: 5000 })).body).toMatchObject({
      enabled: false,
      budget: { monthlyTokens: 5000 },
    })
    const reader = await gateway.person(tenantId, READER)
    expect((await put(reader, { enabled: false })).status).toBe(403)
  })

  it('refuses a key’s token: only a person reaches the assistant', async () => {
    const tenantId = randomUUID()
    const secret = `hz_${randomUUID()}`
    gateway.addKey({
      secret,
      tenantId,
      apiKeyId: randomUUID(),
      issuer: randomUUID(),
      scopes: ['agent:connect', 'parties:read'],
      roles: READER,
    })
    const exchanged = await fetch(`${gateway.url}/auth/api-key/token`, {
      method: 'POST',
      body: JSON.stringify({ tenantId, presented: secret }),
    }).then((response) => response.json() as Promise<{ accessToken: string }>)
    expect((await ask(exchanged.accessToken, 'Quem é a Aurora?')).status).toBe(403)
  })
})

describe('asking (Phase 76)', () => {
  it('reads with the person’s token, cites what it read, and seals the turn', async () => {
    const tenantId = randomUUID()
    await turnOn(tenantId)
    const userId = randomUUID()
    const token = await gateway.person(tenantId, READER, userId)
    const answered = await ask(token, 'Quais clientes têm contrato de café?')
    expect(answered.status).toBe(201)
    expect(answered.body).toMatchObject({
      outcome: 'answered',
      turn: 0,
      toolsCalled: ['search_documents', 'list_parties'],
      statements: [
        { sources: ['S1'], found: true },
        { text: 'list_parties: 1 record(s)', sources: ['S2'], found: true },
      ],
      sources: [
        { id: 'S1', kind: 'document', cited: true },
        { id: 'S2', kind: 'record', tool: 'list_parties', screen: '/app/registrations/parties' },
      ],
    })
    const reads = gateway.reads.filter((read) => read.token === token).map((read) => read.path)
    expect(reads).toEqual(['/knowledge/search', '/parties/parties'])

    const [row] = await administrator<{ sealed: Buffer }[]>`
      select sealed from assistant_turns where conversation_id = ${answered.body.conversationId}`
    expect(row?.sealed.toString('latin1')).not.toMatch(/contrato|Aurora/i)

    const listed = await request(app.getHttpServer())
      .get('/assistant/conversations')
      .set('authorization', `Bearer ${token}`)
      .expect(200)
    expect(listed.body.data).toMatchObject([
      { id: answered.body.conversationId, title: 'Quais clientes têm contrato de café?', turns: 1 },
    ])
    const opened = await request(app.getHttpServer())
      .get(`/assistant/conversations/${answered.body.conversationId}`)
      .set('authorization', `Bearer ${token}`)
      .expect(200)
    expect(opened.body.turns[0]).toMatchObject({ question: 'Quais clientes têm contrato de café?' })

    // Another person of the same workspace sees none of it.
    const other = await gateway.person(tenantId, READER)
    await request(app.getHttpServer())
      .get(`/assistant/conversations/${answered.body.conversationId}`)
      .set('authorization', `Bearer ${other}`)
      .expect(404)
    const theirs = await request(app.getHttpServer())
      .get('/assistant/conversations')
      .set('authorization', `Bearer ${other}`)
      .expect(200)
    expect(theirs.body.data).toEqual([])
  })

  it('stops at the monthly budget, and audits each question without its words', async () => {
    const tenantId = randomUUID()
    await turnOn(tenantId, 1000)
    const token = await gateway.person(tenantId, READER)
    const outcomes: (string | number)[] = []
    for (let attempt = 0; attempt < 10 && !outcomes.includes(429); attempt++) {
      const answer = await ask(token, 'Quais clientes têm contrato?')
      outcomes.push(answer.status === 201 ? answer.body.outcome : answer.status)
      if (answer.status === 429)
        expect(answer.body).toMatchObject({ code: 'assistant-budget-spent' })
    }
    // Answers until the budget is reached, then refusals: never an answer after it.
    expect(outcomes.at(-1)).toBe(429)
    expect(outcomes.slice(0, -1).every((outcome) => outcome !== 429)).toBe(true)
    const status = await request(app.getHttpServer())
      .get('/assistant/status')
      .set('authorization', `Bearer ${token}`)
      .expect(200)
    expect(status.body.budget.spentTokens).toBeGreaterThanOrEqual(1000)
    const audit = await request(app.getHttpServer())
      .get('/audit')
      .set('authorization', `Bearer ${await gateway.person(tenantId, OWNER)}`)
      .expect(200)
    const actions = audit.body.data.map((entry: { action: string }) => entry.action)
    expect(actions).toEqual(
      expect.arrayContaining(['assistant.settings.changed', 'assistant.answered']),
    )
    expect(JSON.stringify(audit.body)).not.toMatch(/clientes|contrato/)
  })
})

describe('what a conversation leaves behind (ADR 0068)', () => {
  it('goes after its 30 days, across tenants, and a read never returns it before the purge', async () => {
    const tenantId = randomUUID()
    await turnOn(tenantId)
    const token = await gateway.person(tenantId, READER)
    const answered = await ask(token, 'Quem é a Aurora?')
    const id = answered.body.conversationId as string
    await administrator`update assistant_conversations set expires_at = now() - interval '1 second' where id = ${id}`
    await request(app.getHttpServer())
      .get(`/assistant/conversations/${id}`)
      .set('authorization', `Bearer ${token}`)
      .expect(404)
    expect(await runtime.assistantDatabase.purgeExpired()).toBeGreaterThanOrEqual(1)
    const [left] = await administrator<{ count: number }[]>`
      select (select count(*) from assistant_conversations where id = ${id})::int
        + (select count(*) from assistant_turns where conversation_id = ${id})::int as count`
    expect(left?.count).toBe(0)
  })

  it('erasing the person destroys their key and conversations, once per event', async () => {
    const tenantId = randomUUID()
    await turnOn(tenantId)
    const userId = randomUUID()
    const token = await gateway.person(tenantId, READER, userId)
    await ask(token, 'Quem é a Aurora?')
    const event = {
      tenantId,
      sourceModule: 'identity',
      eventId: randomUUID(),
      eventType: 'identity.data-subject.erased',
    }
    expect(await runtime.assistantDatabase.erase(event, userId)).toBe(true)
    expect(await runtime.assistantDatabase.erase(event, userId)).toBe(false)
    const [left] = await administrator<{ keys: number; conversations: number }[]>`
      select (select count(*) from assistant_keys where user_id = ${userId})::int as keys,
        (select count(*) from assistant_conversations where user_id = ${userId})::int as conversations`
    expect(left).toEqual({ keys: 0, conversations: 0 })
  })

  it('shows one tenant none of another’s rows, even unfiltered', async () => {
    const a = randomUUID()
    const b = randomUUID()
    await turnOn(a)
    await turnOn(b)
    await ask(await gateway.person(b, READER), 'Quem é a Aurora?')
    const app = postgres(process.env.DATABASE_URL ?? '', { max: 1 })
    try {
      const seen = await app.begin(async (tx) => {
        await tx`select set_config('app.current_tenant', ${a}, true)`
        return tx<{ tenant_id: string }[]>`
          select tenant_id from assistant_conversations
          union all select tenant_id from assistant_turns
          union all select tenant_id from assistant_keys
          union all select tenant_id from assistant_usage`
      })
      expect(seen.every((row) => row.tenant_id === a)).toBe(true)
    } finally {
      await app.end()
    }
  })
})
