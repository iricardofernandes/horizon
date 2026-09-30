#!/usr/bin/env node
/**
 * Phase 79 smoke, against the local stack: messaging that tells who refused what, and
 * webhooks that deliver for every workspace.
 *   1. Every DLQ is bound only to its own queue's dead letters: no catch-all binding is left.
 *   2. A new workspace subscribes to a webhook, and its first event is scheduled for
 *      delivery, with no dead letter.
 *   3. An invalid webhook body is 400, not 500.
 *   4. A workspace that never acted in Treasury, Ledger and Procurement is sealed by them,
 *      so their watermarks move in Reporting.
 *   5. No dead-letter queue grew while it ran.
 * Results go to docs/drills/; non-zero on failure.
 *
 *   node scripts/phase79-smoke.mjs [--base-url http://localhost:8000] [--api http://localhost:15672]
 */
import { randomBytes } from 'node:crypto'
import { flagOf, kit } from './phase-n-kit.mjs'

const args = process.argv.slice(2)
const baseUrl = flagOf(args, 'base-url', 'http://localhost:8000').replace(/\/$/, '')
const api = flagOf(args, 'api', 'http://localhost:15672').replace(/\/$/, '')
const k = kit({ baseUrl, label: 'phase79' })
const startedAt = new Date()
const today = startedAt.toISOString().slice(0, 10)
const broker = { authorization: `Basic ${Buffer.from('horizon:horizon').toString('base64')}` }

async function management(path) {
  const response = await fetch(`${api}/api${path}`, { headers: broker })
  if (!response.ok) throw new Error(`management ${path}: ${response.status}`)
  return response.json()
}

const ownDeadLetters = async (queue) =>
  (await management(`/queues/%2F/${encodeURIComponent(`${queue}.dlq`)}`)).messages ?? 0

const depths = async () =>
  Object.fromEntries(
    (await management('/queues/%2F'))
      .filter((queue) => queue.name.endsWith('.dlq'))
      .map((queue) => [queue.name, queue.messages ?? 0]),
  )

async function run() {
  const depthsBefore = await depths()
  // 1. Bindings.
  const bindings = await management('/bindings/%2F')
  const dlqs = (await management('/queues/%2F')).filter((queue) => queue.name.endsWith('.dlq'))
  const catchAll = bindings.filter(
    (binding) =>
      binding.source === 'horizon.events.dlx' && binding.destination_type === 'queue' && binding.destination.endsWith('.dlq'),
  )
  const unrouted = dlqs.filter(
    (queue) =>
      !bindings.some(
        (binding) =>
          binding.source === 'horizon.dead-letters' &&
          binding.destination === queue.name &&
          binding.arguments?.['x-first-death-queue'] === queue.name.slice(0, -'.dlq'.length),
      ),
  )
  k.check(
    'every DLQ receives only its own queue’s dead letters, and no catch-all binding is left',
    catchAll.length === 0 && unrouted.length === 0 && dlqs.length > 0,
    { dlqs: dlqs.length, catchAll: catchAll.map((binding) => binding.destination), unrouted: unrouted.map((queue) => queue.name) },
  )

  // 2 and 3. Webhooks in a workspace it never saw.
  const owner = await k.workspace('a', ['parties', 'webhooks', 'reporting'])
  const deadBefore = await ownDeadLetters('webhooks.events')
  const invalid = await k.call('/webhooks/webhook-subscriptions', {
    method: 'POST',
    token: owner.token,
    body: { endpointUrl: 'not a url', eventTypes: [] },
  })
  k.check('an invalid webhook body is refused with 400, naming the fields', invalid.status === 400, {
    status: invalid.status,
    message: String(invalid.body?.message ?? '').slice(0, 120),
  })
  const subscribed = await k.call('/webhooks/webhook-subscriptions', {
    method: 'POST',
    token: owner.token,
    body: { endpointUrl: 'https://example.invalid/phase79', eventTypes: ['parties.party.registered'] },
  })
  await k.supplier(owner, `Webhook Fase 79 ${randomBytes(2).toString('hex')} LTDA`)
  const deliveries = await k.until('the event to be scheduled for delivery', async () => {
    const answer = await k.ok('/webhooks/webhook-deliveries', { token: owner.token })
    const rows = Array.isArray(answer) ? answer : (answer.data ?? [])
    return rows.length ? rows : undefined
  })
  const deadAfter = await ownDeadLetters('webhooks.events')
  k.check(
    'a new workspace subscribes, and its first event is scheduled for delivery, not dead-lettered',
    subscribed.status < 300 && deliveries.length >= 1 && deadAfter === deadBefore,
    { subscribed: subscribed.status, deliveries: deliveries.length, deadLettersBefore: deadBefore, deadLettersAfter: deadAfter },
  )

  // 4. Seals for sources the workspace never used.
  const quiet = ['treasury', 'ledger', 'procurement']
  const sealed = await k.until(
    'the quiet sources to be sealed',
    async () => {
      const answer = await k.ok('/reporting/sources', { token: owner.token })
      const rows = answer.sources.filter((source) => quiet.includes(source.source))
      return rows.length === quiet.length && rows.every((row) => row.watermark) ? rows : undefined
    },
    420_000,
  ).catch(() => undefined)
  k.check(
    'sources the workspace never used are sealed, so their watermarks move',
    Boolean(sealed),
    sealed ? sealed.map((row) => ({ source: row.source, watermark: Boolean(row.watermark) })) : 'no watermark within 7 minutes',
  )

  // 5. Nothing the run caused was refused anywhere.
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
const file = await k.store(`${today}-phase79-messaging-smoke.json`, {
  phase: 79,
  kind: 'messaging-smoke',
  baseUrl,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  passed,
  ...(result ?? {}),
  checks: k.checks,
})
console.log(`\n${passed ? 'passed' : 'FAILED'} — ${k.checks.length} checks, stored in ${file}`)
process.exit(passed ? 0 : 1)
