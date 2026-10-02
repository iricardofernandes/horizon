#!/usr/bin/env node
/**
 * Moves a broker to one identity per module (Phase 90, ADR 0075).
 *
 * Until Phase 90 every queue dead-lettered into the shared `horizon.events.dlx`, which a
 * headers exchange routed by the queue a message died in. A module's broker user may now
 * write only to its own names, so each queue dead-letters into an exchange of its own,
 * `<queue>.dlx`. RabbitMQ cannot change a live queue's arguments, so each queue declared
 * the old way is deleted, empty and with no consumer, and its service declares it again
 * at start. The dead-letter queues and what they hold are kept.
 *
 * Without flags it reports what it would do. With `--apply`, run with every service
 * stopped, it deletes the old queues, then the two legacy exchanges once nothing uses them.
 *
 *   node scripts/migrate-broker-identities.mjs [--api http://localhost:15672]
 *     [--user horizon] [--password horizon] [--apply]
 */
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const api = flag('api', 'http://localhost:15672').replace(/\/$/, '')
const user = flag('user', process.env.HORIZON_RABBITMQ_ADMIN_USER ?? 'horizon')
const password = flag('password', process.env.HORIZON_RABBITMQ_ADMIN_PASSWORD ?? 'horizon')
const apply = args.includes('--apply')
const LEGACY_DLX = 'horizon.events.dlx'
const LEGACY_ROUTER = 'horizon.dead-letters'

const authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
async function call(method, path) {
  const response = await fetch(`${api}/api${path}`, { method, headers: { authorization } })
  if (!response.ok && response.status !== 404)
    throw new Error(`${method} ${path} answered ${response.status}`)
  return response.status === 204 || response.status === 404 ? null : response.json()
}

const queues = (await call('GET', '/queues/%2F')) ?? []
const legacy = queues.filter((queue) => queue.arguments?.['x-dead-letter-exchange'] === LEGACY_DLX)
const busy = legacy.filter((queue) => (queue.consumers ?? 0) > 0 || (queue.messages ?? 0) > 0)
const report = {
  legacyQueues: legacy.map((queue) => queue.name),
  busy: busy.map((queue) => ({
    name: queue.name,
    consumers: queue.consumers ?? 0,
    messages: queue.messages ?? 0,
  })),
  applied: false,
}

if (apply) {
  if (busy.length > 0) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    process.stderr.write('Stop every service and let the queues drain before applying.\n')
    process.exit(1)
  }
  for (const queue of legacy)
    await call('DELETE', `/queues/%2F/${encodeURIComponent(queue.name)}?if-empty=true&if-unused=true`)
  // The legacy exchanges go once no queue dead-letters into them any more.
  const remaining = ((await call('GET', '/queues/%2F')) ?? []).filter(
    (queue) => queue.arguments?.['x-dead-letter-exchange'] === LEGACY_DLX,
  )
  if (remaining.length === 0) {
    await call('DELETE', `/exchanges/%2F/${encodeURIComponent(LEGACY_ROUTER)}`)
    await call('DELETE', `/exchanges/%2F/${encodeURIComponent(LEGACY_DLX)}`)
  }
  report.applied = true
  report.legacyExchangesRemoved = remaining.length === 0
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
