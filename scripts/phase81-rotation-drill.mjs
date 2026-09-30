#!/usr/bin/env node
/**
 * Phase 81 drill, against the local stack: rotate both master keys and take the old ones
 * away, with a document and a conversation that must stay readable throughout; then rotate
 * back, so the stack ends as it began. It also makes a burst of refused key exchanges and
 * checks Identity counts them and names the key.
 *
 *   1. Before: a document is found and cited; a conversation is read back.
 *   2. Rotation: `knowledge` and `agent` restart with a new master key and the old one as
 *      previous (Knowledge keeps its lexeme key). The rewrap workers move every key.
 *   3. Retirement: they restart with the new key alone. The document and the conversation
 *      read exactly as before.
 *   4. Back: the same two steps from the new key to the original one.
 *   5. Twenty-five exchanges of an unknown key are refused, counted by outcome, and logged
 *      by the key's prefix, never its secret.
 *
 * Restarts go through Docker Compose. Results go to docs/drills/; non-zero on failure.
 *
 *   node scripts/phase81-rotation-drill.mjs [--base-url http://localhost:8000]
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { flagOf, kit, NOTICE, root } from './phase-n-kit.mjs'

const args = process.argv.slice(2)
const baseUrl = flagOf(args, 'base-url', 'http://localhost:8000').replace(/\/$/, '')
const prometheus = flagOf(args, 'prometheus', 'http://localhost:9090').replace(/\/$/, '')
const k = kit({ baseUrl, label: 'phase81' })
const startedAt = new Date()
const today = startedAt.toISOString().slice(0, 10)

// The compose defaults: what the stack runs with when nothing is set.
const ORIGINAL = {
  knowledge: '6c6f63616c2d6b6e6f776c656467652d6d61737465722d6b65792d6368616e67',
  assistant: '6c6f63616c2d617373697374616e742d6d61737465722d6b65792d6368616e67',
}
const fresh = { knowledge: randomBytes(32).toString('hex'), assistant: randomBytes(32).toString('hex') }
const compose = ['compose', '-f', 'infra/docker-compose.yml', '--env-file', 'infra/.env', '-f', 'infra/docker-compose.apps.yml']

/** Restart the two services with the keys given; the lexeme key never changes. */
function restart({ knowledge, assistant, previous }) {
  execFileSync('docker', [...compose, 'up', '-d', '--wait', '--no-deps', '--force-recreate', 'knowledge', 'agent'], {
    cwd: root,
    stdio: 'ignore',
    timeout: 300_000,
    env: {
      ...process.env,
      HORIZON_RUNTIME_UID: String(process.getuid?.() ?? 1000),
      HORIZON_RUNTIME_GID: String(process.getgid?.() ?? 1000),
      HORIZON_KNOWLEDGE_MASTER_KEY: knowledge,
      HORIZON_KNOWLEDGE_PREVIOUS_MASTER_KEYS: previous?.knowledge ?? '',
      HORIZON_KNOWLEDGE_LEXEME_KEY: ORIGINAL.knowledge,
      HORIZON_ASSISTANT_MASTER_KEY: assistant,
      HORIZON_ASSISTANT_PREVIOUS_MASTER_KEYS: previous?.assistant ?? '',
    },
  })
}

const sql = (database, query) =>
  execFileSync('docker', ['exec', 'horizon-postgres', 'psql', '-U', 'postgres', '-d', database, '-Atc', query], {
    encoding: 'utf8',
  }).trim()

/** The master key names in use: one per service once the rewrap is done. */
const names = () => ({
  knowledge: sql('horizon_knowledge', 'select distinct master_key_id from documents where wrapped_key is not null')
    .split('\n')
    .filter(Boolean),
  assistant: sql('horizon_agent', 'select distinct master_key_id from assistant_keys').split('\n').filter(Boolean),
})

const logged = (service, since) =>
  execFileSync('docker', ['logs', '--since', since, `horizon-${service}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

async function readable(owner, partyContract, conversationId) {
  const searched = await k.search(owner.token, 'contrato de fornecimento de café')
  const cited = searched.data.find((citation) => citation.attachmentId === partyContract)
  const conversation = await k.call(`/agent/assistant/conversations/${conversationId}`, { token: owner.token })
  return {
    found: Boolean(cited?.excerpt?.includes('café torrado')),
    conversation: conversation.status === 200 && conversation.body.turns?.[0]?.question === 'O que diz o contrato de café?',
  }
}

/** Both read, or nothing yet: a service just recreated answers after a moment. */
const settled = (owner, contract, conversationId) =>
  readable(owner, contract, conversationId)
    .then((read) => (read.found && read.conversation ? read : undefined))
    .catch(() => undefined)

/** Rotate from one key pair to another, with the old pair as previous, then retire it. */
async function rotate(from, to, owner, contract, conversationId, label) {
  const since = new Date().toISOString()
  restart({ ...to, previous: from })
  const rewrapped = await k.until(
    `${label}: every key under the new master key`,
    async () => {
      const knowledge = logged('knowledge', since).includes('every document key is wrapped under the current master key')
      const assistant = logged('agent', since).includes('every person key is wrapped under the current master key')
      const current = names()
      return knowledge && assistant && current.knowledge.length === 1 && current.assistant.length === 1 ? current : undefined
    },
    180_000,
  )
  // A recreated container has a new address, which Kong resolves again within seconds.
  const during = await k.until(`${label}: the services back`, () => settled(owner, contract, conversationId), 120_000)
  restart({ ...to })
  const after = await k.until(`${label}: the services back`, () => settled(owner, contract, conversationId), 120_000)
  return { rewrapped, during, after }
}

async function run() {
  // 1. A document and a conversation.
  const owner = await k.workspace('a', ['parties'])
  const partyId = await k.supplier(owner, `Torrefação Fase 81 ${randomBytes(2).toString('hex')} LTDA`)
  const contract = await k.attach(
    owner,
    { module: 'parties', recordType: 'party', recordId: partyId },
    'contrato.txt',
    'Contrato de fornecimento de café torrado, com entregas mensais em Campinas.',
  )
  await k.until(
    'the contract to be indexed',
    async () => (k.ids(await k.search(owner.token, 'fornecimento de café')).includes(contract) ? true : undefined),
    180_000,
  )
  await k.ok('/agent/assistant/settings', { method: 'PUT', token: owner.token, body: { enabled: true, acceptNotice: NOTICE } })
  const asked = await k.ok('/agent/assistant/questions', {
    method: 'POST',
    token: owner.token,
    body: { question: 'O que diz o contrato de café?' },
  })
  const before = await readable(owner, contract, asked.conversationId)
  const original = names()
  k.check('before: the document is found and cited, and the conversation reads back', before.found && before.conversation, before)

  // 2 and 3. To new keys, and the old ones retired.
  const forward = await rotate(ORIGINAL, fresh, owner, contract, asked.conversationId, 'forward')
  k.check(
    'rotated: every document and person key moved to the new master keys, and read throughout',
    forward.rewrapped.knowledge[0] !== original.knowledge[0] &&
      forward.rewrapped.assistant[0] !== original.assistant[0] &&
      forward.during.found && forward.during.conversation,
    { before: original, after: forward.rewrapped, during: forward.during },
  )
  k.check(
    'retired: with the old master keys gone, the document and the conversation read as before',
    forward.after.found && forward.after.conversation,
    forward.after,
  )

  // 4. Back to the original keys, so the stack ends as it began.
  const back = await rotate(fresh, ORIGINAL, owner, contract, asked.conversationId, 'back')
  k.check(
    'rotated back to the original keys, and everything still reads',
    back.rewrapped.knowledge[0] === original.knowledge[0] &&
      back.rewrapped.assistant[0] === original.assistant[0] &&
      back.after.found && back.after.conversation,
    { names: back.rewrapped, after: back.after },
  )

  // 5. A burst of refused exchanges, once Prometheus holds the series at its start.
  const query = async (expression) => {
    const response = await fetch(`${prometheus}/api/v1/query?query=${encodeURIComponent(expression)}`)
    return (await response.json()).data?.result ?? []
  }
  const baseline = await k.until(
    'the refused-exchange series to exist',
    async () => {
      const [series] = await query('identity_api_key_exchanges_total{outcome="refused"}')
      return series ? Number(series.value[1]) + 1 : undefined
    },
    120_000,
  ).catch(() => 0)
  const since = new Date().toISOString()
  const prefix = randomBytes(12).toString('hex').slice(0, 24).replace(/[^A-Za-z0-9]/g, 'x')
  const unknownKey = { secret: `hz_test_${prefix}_${randomBytes(16).toString('hex')}`, tenantId: owner.tenantId }
  const statuses = []
  for (let attempt = 0; attempt < 25; attempt++) statuses.push((await k.exchange(unknownKey)).status)
  const refusedLines = logged('identity', since)
    .split('\n')
    .filter((line) => line.includes('API key exchange refused'))
  const counted = await k.until(
    'Prometheus to count the refusals',
    async () => {
      const [result] = await query('sum(increase(identity_api_key_exchanges_total{outcome="refused"}[5m]))')
      const value = Number(result?.value?.[1] ?? 0)
      return value >= 20 ? value : undefined
    },
    120_000,
  ).catch(() => 0)
  k.check(
    'refused key exchanges are counted by outcome, and logged by the key’s prefix, never its secret',
    baseline > 0 &&
      statuses.every((status) => status === 401) &&
      counted >= 20 &&
      refusedLines.length >= 25 &&
      refusedLines.every((line) => line.includes(prefix) && !line.includes(unknownKey.secret.slice(-32))),
    { refused: statuses.length, counted: Math.round(counted), loggedByPrefix: refusedLines.length },
  )
  return { tenantId: owner.tenantId }
}

let result
try {
  result = await run()
} catch (error) {
  k.check('the drill ran to the end', false, String(error).slice(0, 300))
  // Whatever happened, the stack goes back to its own keys, still able to open what was
  // rewrapped under the drill's; the rewrap worker then moves it back.
  try {
    restart({ ...ORIGINAL, previous: fresh })
  } catch {}
}
const passed = k.checks.every((entry) => entry.passed)
const file = await k.store(`${today}-phase81-rotation-drill.json`, {
  phase: 81,
  kind: 'rotation-drill',
  baseUrl,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  passed,
  ...(result ?? {}),
  checks: k.checks,
})
console.log(`\n${passed ? 'passed' : 'FAILED'} — ${k.checks.length} checks, stored in ${file}`)
process.exit(passed ? 0 : 1)
