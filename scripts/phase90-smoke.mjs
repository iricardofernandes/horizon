#!/usr/bin/env node
/**
 * Phase 90 smoke, against the local stack: who may speak on the bus, and where webhooks
 * may go (ADR 0075).
 *   1. The broker holds exactly the users and permissions `make broker-config` rendered,
 *      and every service is connected as its own module.
 *   2. Sales may not publish another module's event, write to the default exchange, to the
 *      journal as another module, or to another module's dead-letter exchange, nor declare
 *      or read another module's queue. Webhooks may not publish at all.
 *   3. The MCP debugger lists queues and can neither read nor publish a message.
 *   4. Every queue dead-letters into an exchange of its own, bound to its DLQ alone, and
 *      nothing of the shared dead-letter exchanges is left.
 *   5. A webhook to an address inside the network is refused with 400, by URL and by name.
 *   6. No dead-letter queue grew while it ran.
 * Every refused publish carries a body no consumer would apply. Results go to docs/drills/;
 * no password is ever printed or stored. Non-zero on failure.
 *
 *   node scripts/phase90-smoke.mjs [--base-url http://localhost:8000]
 *     [--api http://localhost:15672] [--amqp-port 5672]
 */
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import {
  ADMIN_USER,
  adminPassword,
  definitionsOf,
  environmentFrom,
  MODULES,
  MONITOR_USER,
  passwordFor,
} from '../infra/scripts/broker-definitions.mjs'
import { flagOf, kit, root } from './phase-n-kit.mjs'

// amqplib is a dependency of the modules, not of the repository: borrow one module's copy.
const amqp = createRequire(join(root, 'knowledge/package.json'))('amqplib')

const args = process.argv.slice(2)
const baseUrl = flagOf(args, 'base-url', 'http://localhost:8000').replace(/\/$/, '')
const api = flagOf(args, 'api', 'http://localhost:15672').replace(/\/$/, '')
const environment = environmentFrom(join(root, 'infra', '.env'))
const amqpPort = flagOf(args, 'amqp-port', environment.HORIZON_RABBITMQ_PORT || '5672')
const k = kit({ baseUrl, label: 'phase90' })
const startedAt = new Date()
const today = startedAt.toISOString().slice(0, 10)
const LEGACY_EXCHANGES = ['horizon.events.dlx', 'horizon.dead-letters']

const secretOf = (user) =>
  user === ADMIN_USER ? adminPassword(environment) : passwordFor(user, environment)
const basic = (user) =>
  `Basic ${Buffer.from(`${user}:${secretOf(user)}`).toString('base64')}`

async function management(path, { user = ADMIN_USER, method = 'GET', body } = {}) {
  const response = await fetch(`${api}/api${path}`, {
    method,
    headers: { authorization: basic(user), 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await response.text()
  let parsed = text
  try {
    parsed = JSON.parse(text)
  } catch {}
  return { status: response.status, body: parsed }
}

async function listed(path) {
  const answer = await management(path)
  if (answer.status !== 200) throw new Error(`management ${path}: ${answer.status}`)
  return answer.body
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Runs one act as a module's broker user and tells whether the broker refused it. A refusal
 * closes the channel with ACCESS_REFUSED; an act that went through closes nothing.
 */
async function attempt(user, act) {
  const url = `amqp://${encodeURIComponent(user)}:${encodeURIComponent(secretOf(user))}@localhost:${amqpPort}`
  const connection = await amqp.connect(url)
  connection.on('error', () => {})
  try {
    const channel = await connection.createConfirmChannel()
    const errored = new Promise((resolve) => channel.once('error', resolve))
    let actError = null
    try {
      await act(channel)
    } catch (error) {
      actError = error
    }
    const channelError = await Promise.race([errored, sleep(1500).then(() => null)])
    const reason = String(channelError?.message ?? actError?.message ?? '')
    // amqplib quotes the broker's own words: keep those, without the quotes.
    const said = reason.split(' - ')[1]?.replace(/"$/, '') ?? reason
    return { refused: /ACCESS_REFUSED/.test(reason), reason: said.slice(0, 160) }
  } finally {
    await connection.close().catch(() => {})
  }
}

const probe = () => Buffer.from(JSON.stringify({ probe: 'phase90', nonce: randomBytes(4).toString('hex') }))
const publish = (exchange, key) => (channel) =>
  new Promise((resolve, reject) =>
    channel.publish(exchange, key, probe(), { persistent: false }, (error) => (error ? reject(error) : resolve())),
  )

const depths = async () =>
  Object.fromEntries(
    (await listed('/queues/%2F'))
      .filter((queue) => queue.name.endsWith('.dlq'))
      .map((queue) => [queue.name, queue.messages ?? 0]),
  )

async function run() {
  const depthsBefore = await depths()

  // 1. The users and permissions are the rendered ones, and every service is itself.
  const expected = definitionsOf(environment)
  const users = (await listed('/users')).map((user) => user.name).sort()
  k.check(
    'the broker holds exactly the rendered users: one per module, the operator and the monitor',
    JSON.stringify(users) === JSON.stringify(expected.users.map((user) => user.name).sort()),
    { users },
  )
  const permissions = await listed('/permissions')
  const topics = await listed('/topic-permissions')
  const drift = expected.permissions.filter((wanted) => {
    const held = permissions.find((granted) => granted.user === wanted.user && granted.vhost === wanted.vhost)
    return !held || held.configure !== wanted.configure || held.write !== wanted.write || held.read !== wanted.read
  })
  const topicDrift = expected.topic_permissions.filter(
    (wanted) =>
      !topics.some(
        (held) =>
          held.user === wanted.user &&
          held.exchange === wanted.exchange &&
          held.write === wanted.write &&
          held.read === wanted.read,
      ),
  )
  k.check(
    'every user holds the permissions and topic permissions rendered for it, and no others',
    drift.length === 0 &&
      topicDrift.length === 0 &&
      permissions.length === expected.permissions.length &&
      topics.length === expected.topic_permissions.length,
    { drift: drift.map((entry) => entry.user), topicDrift: topicDrift.map((entry) => `${entry.user}@${entry.exchange}`) },
  )
  const connections = await listed('/connections')
  const connectedAs = new Set(connections.map((connection) => connection.user))
  const absent = Object.keys(MODULES).filter((module) => !connectedAs.has(module))
  const asOperator = connections.filter((connection) => connection.user === ADMIN_USER).length
  k.check(
    'every service is connected to the broker as its own module, and none as the operator',
    absent.length === 0 && asOperator === 0,
    { absent, connectionsAsOperator: asOperator },
  )

  // 2. What a module may not do on the bus.
  const refusals = {
    "sales publishing Financial's event": await attempt('sales', publish('horizon.events', 'financial.settlement.recorded')),
    'sales writing to the default exchange': await attempt('sales', publish('', 'financial.events')),
    'sales publishing a Financial seal to the journal': await attempt('sales', publish('horizon.journal', 'financial.seal')),
    "sales writing to Ledger's dead-letter exchange": await attempt('sales', publish('ledger.events.dlx', '')),
    'sales declaring a Financial queue': await attempt('sales', (channel) =>
      channel.assertQueue(`financial.phase90-${randomBytes(3).toString('hex')}`, { exclusive: true, autoDelete: true }),
    ),
    "sales reading Financial's queue": await attempt('sales', (channel) => channel.get('financial.events', { noAck: false })),
    'webhooks publishing anything': await attempt('webhooks', publish('horizon.events', 'webhooks.anything')),
  }
  for (const [act, outcome] of Object.entries(refusals))
    k.check(`the broker refuses ${act}`, outcome.refused, outcome)

  // 3. The monitor sees depths and touches no message.
  const monitorQueues = await management('/queues/%2F', { user: MONITOR_USER })
  const monitorGet = await management('/queues/%2F/sales.events.dlq/get', {
    user: MONITOR_USER,
    method: 'POST',
    body: { count: 1, ackmode: 'ack_requeue_true', encoding: 'auto' },
  })
  const monitorPublish = await management('/exchanges/%2F/horizon.events/publish', {
    user: MONITOR_USER,
    method: 'POST',
    body: { properties: {}, routing_key: 'sales.order.confirmed', payload: '{"probe":"phase90"}', payload_encoding: 'string' },
  })
  k.check(
    'the MCP debugger lists queues, and may neither read nor publish a message',
    monitorQueues.status === 200 &&
      Array.isArray(monitorQueues.body) &&
      monitorQueues.body.length > 0 &&
      monitorGet.status >= 400 &&
      monitorPublish.status >= 400,
    { list: monitorQueues.status, get: monitorGet.status, publish: monitorPublish.status },
  )

  // 4. Dead letters: each queue its own exchange, each exchange its own DLQ.
  const queues = await listed('/queues/%2F')
  const exchanges = (await listed('/exchanges/%2F')).map((exchange) => exchange)
  const bindings = await listed('/bindings/%2F')
  const consumerQueues = queues.filter((queue) => !queue.name.endsWith('.dlq') && !queue.exclusive)
  const wrong = consumerQueues.filter((queue) => {
    const exchange = exchanges.find((candidate) => candidate.name === `${queue.name}.dlx`)
    const fed = bindings.filter((binding) => binding.source === `${queue.name}.dlx`)
    return (
      queue.arguments?.['x-dead-letter-exchange'] !== `${queue.name}.dlx` ||
      exchange?.type !== 'fanout' ||
      fed.length !== 1 ||
      fed[0].destination !== `${queue.name}.dlq`
    )
  })
  const legacy = exchanges.filter((exchange) => LEGACY_EXCHANGES.includes(exchange.name)).map((exchange) => exchange.name)
  k.check(
    'every queue dead-letters into an exchange of its own, bound to its DLQ alone, and no shared one is left',
    consumerQueues.length > 0 && wrong.length === 0 && legacy.length === 0,
    { queues: consumerQueues.length, wrong: wrong.map((queue) => queue.name), legacy },
  )

  // 5. Webhooks reach the public internet only.
  const owner = await k.workspace('a', ['webhooks'])
  const subscribe = (endpointUrl) =>
    k.call('/webhooks/webhook-subscriptions', {
      method: 'POST',
      token: owner.token,
      body: { endpointUrl, eventTypes: ['sales.order.confirmed'] },
    })
  const refusedEndpoints = {}
  for (const endpointUrl of [
    'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.5/hooks',
    'https://localhost/hooks',
    'http://example.com/hooks',
    // Inside the stack, these names resolve to the network the services run in.
    'https://rabbitmq/hooks',
    'https://postgres:5432/hooks',
  ])
    refusedEndpoints[endpointUrl] = (await subscribe(endpointUrl)).status
  const accepted = await subscribe(`https://example.com/horizon-phase90/${randomBytes(4).toString('hex')}`)
  k.check(
    'a webhook inside the network is refused with 400, by address and by name; a public one is taken',
    Object.values(refusedEndpoints).every((status) => status === 400) && accepted.status < 300,
    { refused: refusedEndpoints, public: accepted.status },
  )

  // 6. Nothing the run caused was dead-lettered.
  const depthsAfter = await depths()
  const grew = Object.entries(depthsAfter).filter(([name, depth]) => depth > (depthsBefore[name] ?? 0))
  k.check('no dead-letter queue grew during the run', grew.length === 0, Object.fromEntries(grew))
  return { tenantId: owner.tenantId }
}

let result
try {
  result = await run()
} catch (error) {
  k.check('the smoke ran to the end', false, String(error).slice(0, 300))
}
const passed = k.checks.every((entry) => entry.passed)
const file = await k.store(`${today}-phase90-bus-identity-smoke.json`, {
  phase: 90,
  kind: 'bus-identity-smoke',
  baseUrl,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  passed,
  ...(result ?? {}),
  checks: k.checks,
})
console.log(`\n${passed ? 'passed' : 'FAILED'} — ${k.checks.length} checks, stored in ${file}`)
process.exit(passed ? 0 : 1)
