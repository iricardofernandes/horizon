#!/usr/bin/env node
/**
 * The Phase N golden path (Phase 78), on the local stack through Kong. It walks what Phase N
 * promised, end to end, in a new workspace:
 *   1. a key is issued, and the agent reads through it;
 *   2. the agent drafts a payable; its issuer is refused approval, and another person
 *      approves it; Financial's audit names the issuer and the key;
 *   3. a document is attached, indexed, found and cited by search, by the agent and by
 *      the assistant;
 *   4. the party is erased, and its document is gone from search and from answers.
 *
 * `--ai off` (the default) runs it with every AI component off: no `ai` profile, the hash
 * embedder, suggestions off, the extractive generator and no model key. `--ai on` expects
 * `make up-ai`. The record goes to docs/drills/<date>-phase-n-golden-path-ai-<mode>.json.
 *
 *   node scripts/phase-n-golden-path.mjs [--ai off|on] [--base-url http://localhost:8000]
 */
import { randomBytes } from 'node:crypto'
import { flagOf, kit, NOTICE } from './phase-n-kit.mjs'

const args = process.argv.slice(2)
const baseUrl = flagOf(args, 'base-url', 'http://localhost:8000').replace(/\/$/, '')
const mode = flagOf(args, 'ai', 'off')
if (!['on', 'off'].includes(mode)) throw new Error('--ai is on or off')
const k = kit({ baseUrl, label: 'phase-n-golden' })
const startedAt = new Date()
const today = startedAt.toISOString().slice(0, 10)
const timings = {}

async function step(name, work) {
  const started = performance.now()
  try {
    return await work()
  } finally {
    timings[name] = Math.round(performance.now() - started)
  }
}

async function run() {
  // --- The workspace, two people, a supplier ---------------------------------------------
  const { owner, approver, partyId, categoryId } = await step('setup', async () => {
    const owner = await k.workspace('a', ['parties', 'financial'])
    const approver = await k.person(owner, 'Second Approver', [{ module: 'financial', role: 'admin' }])
    // Every payable above R$ 1,00 needs an approval, so the drafted one does.
    await k.ok('/financial/payables/approval-policies', {
      method: 'PUT',
      token: owner.token,
      body: { currency: 'BRL', threshold: '100' },
    })
    const categories = (await k.ok('/financial/categories', { token: owner.token })).data
    const category =
      categories.find((entry) => entry.nature === 'expense' && entry.active !== false) ??
      (await k.ok('/financial/categories', {
        method: 'POST',
        token: owner.token,
        body: { code: `GPN-${randomBytes(2).toString('hex')}`, name: 'Matéria-prima', nature: 'expense' },
      }))
    const partyId = await k.supplier(owner, 'Torrefação Caminho N LTDA')
    return { owner, approver, partyId, categoryId: category.id }
  })

  const environment = await step('environment', async () => {
    const status = await k.ok('/knowledge/status', { token: owner.token })
    const suggestions = await k.ok(`/knowledge/suggestions/payable-category?text=${encodeURIComponent('Café verde em sacas')}`, {
      token: owner.token,
    }).catch(() => ({ available: null }))
    const assistant = await k.ok('/agent/assistant/status', { token: owner.token })
    return {
      indexVersion: status.indexVersion,
      suggestionsAvailable: suggestions.available,
      assistant: { provider: assistant.provider, model: assistant.model, available: assistant.available, enabled: assistant.enabled },
    }
  })
  k.check(
    `the stack runs with the ai profile ${mode}`,
    mode === 'on'
      ? environment.indexVersion.startsWith('e5-') && environment.suggestionsAvailable === true
      : environment.indexVersion.startsWith('hash-') && environment.suggestionsAvailable === false &&
          environment.assistant.model === 'extractive-v1' && environment.assistant.enabled === false,
    environment,
  )

  // --- 1. A key, and the agent reads ------------------------------------------------------
  const key = await step('key', async () => {
    await k.ok('/agent/settings', { method: 'PUT', token: owner.token, body: { enabled: true } })
    return k.issueKey(owner, 'Golden path agent', ['agent:connect', 'parties:read', 'financial:write', 'knowledge:read'])
  })
  const read = await step('agent reads', () => k.tool(key, 'list_parties', { role: 'supplier' }))
  k.check(
    'the agent reads the workspace through the key',
    !read.isError && (read.result?.data ?? read.result ?? []).some?.((party) => (party.id ?? party.partyId) === partyId),
    { status: read.status, isError: read.isError },
  )

  // --- 2. The agent drafts; duties hold ---------------------------------------------------
  const drafted = await step('agent drafts', () =>
    k.until('the supplier in Financial', async () => {
      const answer = await k.tool(key, 'draft_payable', {
        partyId,
        documentNumber: `NF-GPN-${randomBytes(3).toString('hex')}`,
        description: 'Café verde em sacas',
        currency: 'BRL',
        categoryId,
        issuedOn: today,
        installments: [{ dueOn: today, amount: '150000' }],
      })
      return !answer.isError && answer.result?.id ? answer : undefined
    }),
  )
  const payableId = drafted.result.id
  k.check('the agent drafts a payable through the key', typeof payableId === 'string', { status: drafted.status })

  const duties = await step('approval', async () => {
    const requested = await k.call(`/financial/payables/${payableId}/approval-request`, { method: 'POST', token: owner.token, body: {} })
    const refused = await k.call(`/financial/payables/${payableId}/approve`, { method: 'POST', token: owner.token, body: {} })
    const approved = await k.call(`/financial/payables/${payableId}/approve`, { method: 'POST', token: approver.token, body: {} })
    const detail = await k.ok(`/financial/payables/${payableId}`, { token: owner.token })
    const audit = await k.ok(`/financial/audit?subjectId=${payableId}`, { token: owner.token })
    const first = [...(audit.data ?? [])].sort((a, b) => a.sequence - b.sequence)[0]
    return { requested, refused, approved, detail, first }
  })
  k.check(
    'the key’s issuer is refused approval of what the agent drafted, and another person approves',
    duties.requested.status < 300 &&
      duties.refused.status === 403 &&
      JSON.stringify(duties.refused.body).includes('segregation-of-duties') &&
      duties.approved.status < 300,
    { request: duties.requested.status, issuer: duties.refused.status, other: duties.approved.status, status: duties.detail.status },
  )
  k.check(
    'Financial’s audit counts the draft as the issuer’s, and names the key it came through',
    duties.first?.actor === owner.userId && typeof duties.first?.details?.via === 'string' && duties.first.details.via.includes(key.id),
    { actorIsIssuer: duties.first?.actor === owner.userId, viaNamesTheKey: String(duties.first?.details?.via ?? '').includes(key.id) },
  )

  // --- 3. A document: indexed, found, cited -----------------------------------------------
  const contract = await step('attach', () =>
    k.attach(owner, { module: 'parties', recordType: 'party', recordId: partyId }, 'contrato.txt',
      'Contrato de fornecimento de café torrado, com entregas mensais em Campinas.'),
  )
  await step('indexed', () =>
    k.until('the contract to be indexed', async () =>
      k.ids(await k.search(owner.token, 'fornecimento de café')).includes(contract) ? true : undefined, 180_000),
  )
  const found = await step('found and cited', async () => {
    const searched = await k.search(owner.token, 'contrato de fornecimento de café')
    const byAgent = await k.tool(key, 'search_documents', { q: 'contrato de fornecimento de café' })
    await k.ok('/agent/assistant/settings', { method: 'PUT', token: owner.token, body: { enabled: true, acceptNotice: NOTICE } })
    const answered = await k.ok('/agent/assistant/questions', {
      method: 'POST',
      token: owner.token,
      body: { question: 'O que diz o contrato de fornecimento de café?' },
    })
    return { searched, byAgent, answered }
  })
  const cited = found.searched.data.find((citation) => citation.attachmentId === contract)
  k.check(
    'search finds the document and cites its attachment, record and excerpt',
    cited?.record.recordId === partyId && cited.excerpt.includes('café torrado'),
    { rank: found.searched.data.findIndex((citation) => citation.attachmentId === contract) + 1 },
  )
  k.check(
    'the agent’s search_documents and the assistant cite it too',
    (found.byAgent.result?.data ?? []).some((citation) => citation.attachmentId === contract) &&
      found.answered.sources.some((source) => source.cited && source.attachmentId === contract),
    { agent: !found.byAgent.isError, assistantStatements: found.answered.statements.length },
  )

  // --- 4. Erasure --------------------------------------------------------------------------
  const erasure = await step('erasure', async () => {
    const erased = await k.call(`/parties/parties/${partyId}`, { method: 'DELETE', token: owner.token })
    await k.until('the erasure to reach the index', async () =>
      k.ids(await k.search(owner.token, 'fornecimento de café')).includes(contract) ? undefined : true, 180_000)
    const byAgent = await k.tool(key, 'search_documents', { q: 'contrato de fornecimento de café' })
    const answered = await k.ok('/agent/assistant/questions', {
      method: 'POST',
      token: owner.token,
      body: { question: 'O que diz o contrato de fornecimento de café?' },
    })
    return { erased, byAgent, answered }
  })
  k.check(
    'erasing the party takes its document out of search and out of every answer',
    erasure.erased.status === 204 &&
      !(erasure.byAgent.result?.data ?? []).some((citation) => citation.attachmentId === contract) &&
      !erasure.answered.sources.some((source) => source.attachmentId === contract) &&
      !JSON.stringify(erasure.answered).includes('café torrado, com entregas'),
    { erased: erasure.erased.status, agent: !erasure.byAgent.isError },
  )

  // --- The agent's own log ------------------------------------------------------------------
  const log = await step('audit', () => k.ok('/agent/audit?action=agent.tool.called&limit=50', { token: owner.token }))
  const calls = (log.data ?? []).filter((entry) => entry.details?.outcome === 'ok')
  k.check(
    'every agent call is in the workspace’s hash-chained log, naming the key',
    calls.length >= 4 && calls.every((entry) => entry.actor.endsWith(key.id)) && log.chain?.status === 'intact',
    { calls: calls.length, chain: log.chain?.status },
  )
  await k.call(`/identity/api-keys/${key.id}`, { method: 'DELETE', token: await k.signIn(owner.email, owner.tenantId) })
  return { tenantId: owner.tenantId, environment }
}

let result
try {
  result = await run()
} catch (error) {
  k.check('the golden path ran to the end', false, String(error).slice(0, 300))
}
const passed = k.checks.every((entry) => entry.passed)
const file = await k.store(`${today}-phase-n-golden-path-ai-${mode}.json`, {
  phase: 78,
  kind: 'phase-n-golden-path',
  ai: mode,
  baseUrl,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  passed,
  ...(result ?? {}),
  timingsMs: timings,
  checks: k.checks,
})
console.log(`\n${passed ? 'passed' : 'FAILED'} — ${k.checks.length} checks, stored in ${file}`)
process.exit(passed ? 0 : 1)
