import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { FiscalCalculationInput } from '@horizon/contracts'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FiscalCalculations } from '../src/calculations'
import { FiscalCatalog } from '../src/catalog'
import { FiscalDelegations } from '../src/delegations'
import {
  approvedPhase41Publication,
  PHASE41_CATALOG_IDENTITY,
  PHASE41_FIXTURE_ID,
  PHASE41_SCENARIO_ID,
} from '../src/phase41-approved-scenario'
import { FiscalRuleChanges, RuleChangeDutiesRefused, RuleChangeRefused } from '../src/rule-changes'
import { FiscalRuleStore } from '../src/rule-store'

/** Phase 88 (ADR 0074): a rule change is requested by one person and decided by another. */

const MASTER_KEY = randomBytes(32)
const ANA = 'admin:ana'
const BRUNO = 'admin:bruno'
const CARLA = 'issuer:carla'

let container: StartedPostgreSqlContainer
let administrator: ReturnType<typeof postgres>
let publisher: FiscalCatalog
let store: FiscalRuleStore
let calculations: FiscalCalculations
let changes: FiscalRuleChanges
let delegations: FiscalDelegations
let fixture: { input: FiscalCalculationInput }
const packageId = PHASE41_CATALOG_IDENTITY.packageId

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('horizon_fiscal_governance_test')
    .withUsername('postgres')
    .withPassword('test')
    .start()
  administrator = postgres(container.getConnectionUri(), { max: 1 })
  await administrator.unsafe(
    `CREATE ROLE horizon_owner LOGIN PASSWORD 'test' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
     CREATE ROLE horizon_app LOGIN PASSWORD 'test' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
     REVOKE ALL ON SCHEMA public FROM PUBLIC;
     GRANT USAGE ON SCHEMA public TO horizon_app;
     GRANT USAGE, CREATE ON SCHEMA public TO horizon_owner;`,
    [],
    { prepare: false },
  )
  const migrationUrl = container.getConnectionUri().replace('postgres:test@', 'horizon_owner:test@')
  const appUrl = container.getConnectionUri().replace('postgres:test@', 'horizon_app:test@')
  await promisify(execFile)(process.execPath, ['scripts/migrate.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_MIGRATION_URL: migrationUrl },
  })
  publisher = new FiscalCatalog(migrationUrl)
  store = new FiscalRuleStore(appUrl)
  calculations = new FiscalCalculations(appUrl, MASTER_KEY, store)
  changes = new FiscalRuleChanges(appUrl, MASTER_KEY, store)
  delegations = new FiscalDelegations(changes.sql)
  fixture = JSON.parse(
    await readFile(
      new URL('../fixtures/rtc-v0057-model55-normal-sale-sp-2026-01.json', import.meta.url),
      'utf8',
    ),
  )
  await publisher.publish(
    approvedPhase41Publication({ byteSize: 346_174_581 }),
    PHASE41_CATALOG_IDENTITY,
  )
}, 120_000)

afterAll(async () => {
  await Promise.allSettled([
    changes?.close(),
    calculations?.close(),
    store?.close(),
    publisher?.close(),
    administrator?.end(),
    container?.stop(),
  ])
})

async function workspace(): Promise<string> {
  const tenantId = randomUUID()
  await administrator`insert into tenants (id) values (${tenantId})`
  return tenantId
}

const inputFor = (tenantId: string): FiscalCalculationInput => ({ ...fixture.input, tenantId })

const adoption = {
  kind: 'adopt-package',
  packageId,
  effectiveFrom: '2026-01-01',
  interpretation: 'The pinned RTC V0057 fixture scenario, as approved in Phase 41.',
  fixtureIds: [PHASE41_FIXTURE_ID],
  reason: 'Adopting the approved scenario from the catalogue',
}

/**
 * A CBS rate of the workspace's own, for the same operation at its establishment, at a higher
 * priority than the law's.
 */
const ownCbs = (ruleKey = 'workspace.cbs-special-regime') => ({
  kind: 'add-rule',
  definition: {
    ruleKey,
    version: 1,
    group: 'ibsCbs',
    code: 'CBS',
    precedence: 'operation',
    priority: 600,
    model: '55',
    environment: 'simulation',
    operation: PHASE41_SCENARIO_ID,
    issuerEstablishmentId: fixture.input.issuerEstablishmentId,
    effectiveFrom: '2026-01-01',
    rate: { numerator: '12', denominator: '1000' },
    formula: 'LINE_NET_TIMES_RATE',
    sourceLocator: 'Regime especial, art. 1º',
  },
  sourceBasis: { uri: 'https://example.gov.br/regime-especial', section: 'art. 1º' },
  reason: 'A special regime granted to this establishment',
})

const decide = (
  tenantId: string,
  changeId: string,
  actorId: string,
  outcome: 'approved' | 'rejected' = 'approved',
  holdsApproval = true,
) => changes.decide({ tenantId, actorId, holdsApproval, changeId, outcome })

async function approved(tenantId: string, body: Record<string, unknown>) {
  const change = await changes.request({ tenantId, actorId: ANA, body })
  return decide(tenantId, change.id, BRUNO)
}

async function lockDocument(tenantId: string): Promise<string> {
  const documentId = randomUUID()
  const intentId = randomUUID()
  await administrator`insert into fiscal_intents (
    id, tenant_id, origin_module, origin_document_type, origin_id, purpose,
    order_id, customer_id, payload_digest
  ) values (
    ${intentId}, ${tenantId}, 'sales', 'shipment', ${randomUUID()}, 'original',
    ${randomUUID()}, ${randomUUID()}, ${'d'.repeat(64)}
  )`
  await administrator`insert into fiscal_documents (
    id, tenant_id, intent_id, model, environment, establishment_id, series,
    snapshot_digest, snapshot_ciphertext
  ) values (
    ${documentId}, ${tenantId}, ${intentId}, '55', 'simulation',
    ${fixture.input.issuerEstablishmentId}, 1, ${'d'.repeat(64)},
    ${Buffer.from('encrypted-placeholder')}
  )`
  const locked = await calculations.validateDocument({
    tenantId,
    documentId,
    actorId: 'issuer:test',
    calculationInput: inputFor(tenantId),
  })
  expect(locked.supported).toBe(true)
  return documentId
}

describe('four eyes on the rules (Phase 88)', () => {
  it('refuses an adoption to the person who asked for it, and applies it once another approves', async () => {
    const tenantId = await workspace()
    const change = await changes.request({ tenantId, actorId: ANA, body: adoption })
    expect(change).toMatchObject({ status: 'pending', requestedBy: ANA, decision: null })
    expect((await calculations.preview(inputFor(tenantId))).supported).toBe(false)

    await expect(decide(tenantId, change.id, ANA)).rejects.toBeInstanceOf(RuleChangeDutiesRefused)
    await expect(decide(tenantId, change.id, ANA, 'rejected')).rejects.toBeInstanceOf(
      RuleChangeDutiesRefused,
    )
    // The store refuses it too, whatever path tries.
    await expect(
      administrator`insert into fiscal_rule_change_decisions (
        tenant_id, change_id, outcome, decided_by
      ) values (${tenantId}, ${change.id}, 'approved', ${ANA})`,
    ).rejects.toThrow(/segregation of duties/)

    const decided = await decide(tenantId, change.id, BRUNO)
    expect(decided.status).toBe('approved')
    expect(decided.decision).toMatchObject({ decidedBy: BRUNO, onBehalfOf: null })
    expect(decided.decision?.resultId).toMatch(/^[0-9a-f-]{36}$/)
    expect((await calculations.preview(inputFor(tenantId))).supported).toBe(true)
    const [adopted] = (await changes.packages(tenantId)).filter((entry) => entry.id === packageId)
    expect(adopted?.adoption).toMatchObject({ state: 'adopted', effectiveFrom: '2026-01-01' })
    await expect(decide(tenantId, change.id, BRUNO)).rejects.toThrow(/was approved/)
    await expect(changes.request({ tenantId, actorId: ANA, body: adoption })).rejects.toThrow(
      /already adopted/,
    )

    const audit = await administrator`select actor_id, action from fiscal_audit_entries
      where tenant_id = ${tenantId} order by sequence`
    expect(audit.map((row) => `${row.actor_id} ${row.action}`)).toEqual([
      `${ANA} rule-change.requested`,
      `${BRUNO} catalog.package-adopted`,
      `${BRUNO} rule-change.approved`,
    ])
  })

  it('lets the requester cancel a pending request, and nobody else', async () => {
    const tenantId = await workspace()
    const change = await changes.request({ tenantId, actorId: ANA, body: adoption })
    await expect(
      changes.request({ tenantId, actorId: BRUNO, body: adoption }),
    ).rejects.toMatchObject({ status: 409, extra: { pendingChangeId: change.id } })
    await expect(
      changes.cancel({ tenantId, actorId: BRUNO, changeId: change.id }),
    ).rejects.toMatchObject({ status: 403 })
    const cancelled = await changes.cancel({ tenantId, actorId: ANA, changeId: change.id })
    expect(cancelled.status).toBe('cancelled')
    await expect(decide(tenantId, change.id, BRUNO)).rejects.toThrow(/was cancelled/)
    expect((await changes.list(tenantId)).data.map((entry) => entry.status)).toEqual(['cancelled'])
  })

  it('lends the approval through a delegation, never to decide the delegator’s own request', async () => {
    const tenantId = await workspace()
    const change = await changes.request({ tenantId, actorId: ANA, body: adoption })
    await expect(decide(tenantId, change.id, CARLA, 'approved', false)).rejects.toMatchObject({
      status: 403,
    })
    const window = {
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 86_400_000).toISOString(),
    }
    const fromAna = await delegations.grant({
      tenantId,
      actorId: ANA,
      holdsApproval: true,
      body: { permission: 'fiscal:rules:approve', delegateId: CARLA, ...window },
    })
    // Lent only by the requester: deciding for her is deciding her own request.
    await expect(decide(tenantId, change.id, CARLA, 'approved', false)).rejects.toBeInstanceOf(
      RuleChangeDutiesRefused,
    )
    await expect(
      delegations.grant({
        tenantId,
        actorId: CARLA,
        holdsApproval: false,
        body: { permission: 'fiscal:rules:approve', delegateId: BRUNO, ...window },
      }),
    ).rejects.toMatchObject({ status: 403 })
    const fromBruno = await delegations.grant({
      tenantId,
      actorId: BRUNO,
      holdsApproval: true,
      body: { permission: 'fiscal:rules:approve', delegateId: CARLA, ...window },
    })
    const decided = await decide(tenantId, change.id, CARLA, 'approved', false)
    expect(decided.decision).toMatchObject({
      decidedBy: CARLA,
      onBehalfOf: BRUNO,
      delegationId: fromBruno.id,
    })
    await delegations.revoke({
      tenantId,
      actorId: BRUNO,
      holdsApproval: true,
      delegationId: fromBruno.id,
    })
    const statuses = Object.fromEntries(
      (await delegations.list(tenantId)).map((entry) => [entry.id, entry.status]),
    )
    expect(statuses).toEqual({ [fromAna.id]: 'active', [fromBruno.id]: 'revoked' })
  })
})

describe('the impact of a change, before anyone approves it (Phase 88)', () => {
  it('lists every locked document whose amounts would change, and those that would not calculate', async () => {
    const tenantId = await workspace()
    await approved(tenantId, adoption)
    const documents = [await lockDocument(tenantId), await lockDocument(tenantId)]

    const special = await changes.request({ tenantId, actorId: ANA, body: ownCbs() })
    expect(special.impact).toMatchObject({ months: 3, examined: 2, unchanged: 0, truncated: false })
    expect(special.impact.changed.map((entry) => entry.documentId).sort()).toEqual(
      [...documents].sort(),
    )
    for (const entry of special.impact.changed)
      expect(entry.components).toEqual([
        { code: 'CBS', before: '90', after: '120', difference: '30' },
      ])
    expect(special.impact.unsupported).toEqual([])

    // Approved, the rule is the workspace's own, and the next calculation uses it.
    const decided = await decide(tenantId, special.id, BRUNO)
    const [rule] = await changes.workspaceRules(tenantId)
    expect(rule).toMatchObject({
      id: decided.decision?.resultId,
      ruleKey: 'workspace.cbs-special-regime',
      approved: true,
      active: true,
    })
    const preview = await calculations.preview(inputFor(tenantId))
    expect(
      preview.supported && preview.lines[0]?.components.ibsCbs.find((c) => c.code === 'CBS'),
    ).toMatchObject({ amount: { amount: '120' } })

    // Locked at the law's rate, the documents do not change when the rule leaves again.
    const retire = await changes.request({
      tenantId,
      actorId: ANA,
      body: { kind: 'retire-rule', ruleId: rule?.id, reason: 'The special regime ended' },
    })
    expect(retire.impact).toMatchObject({ examined: 2, unchanged: 2, changed: [] })

    const withdrawal = await changes.request({
      tenantId,
      actorId: BRUNO,
      body: { kind: 'withdraw-package', packageId, reason: 'Stop calculating with the catalogue' },
    })
    expect(withdrawal.impact.unsupported.map((entry) => entry.documentId).sort()).toEqual(
      [...documents].sort(),
    )
    // The package's approved NCM goes with it, so the line no longer has a classification.
    expect(withdrawal.impact.unsupported[0]?.code).toBe('MISSING_CLASSIFICATION')
  })
})

describe('the diff of a change (Phase 88)', () => {
  it('shows each rule added, ended or changed against what the workspace has', async () => {
    const tenantId = await workspace()
    const before = await changes.diffPackage(tenantId, packageId)
    expect(before.counts).toEqual({ added: 3, ended: 0, changed: 0, unchanged: 0 })
    await approved(tenantId, adoption)
    expect((await changes.diffPackage(tenantId, packageId)).counts).toEqual({
      added: 0,
      ended: 0,
      changed: 0,
      unchanged: 3,
    })

    // The same key as the law's CBS, for the establishment: the rule changes, field by field.
    const replacing = await changes.request({
      tenantId,
      actorId: ANA,
      body: ownCbs('rtc.v0057.model55.normal-sale.cbs'),
    })
    const [entry] = replacing.diff.entries
    expect(entry).toMatchObject({ ruleKey: 'rtc.v0057.model55.normal-sale.cbs', change: 'changed' })
    expect(entry?.fields.map((field) => field.field)).toEqual([
      'priority',
      'scope',
      'effectiveTo',
      'rate',
      'sourceLocator',
    ])
    expect(entry?.fields.find((field) => field.field === 'rate')).toEqual({
      field: 'rate',
      before: { numerator: '9', denominator: '1000' },
      after: { numerator: '12', denominator: '1000' },
    })

    const withdrawal = await changes.request({
      tenantId,
      actorId: ANA,
      body: { kind: 'withdraw-package', packageId, reason: 'Stop calculating with the catalogue' },
    })
    expect(withdrawal.diff.counts).toEqual({ added: 0, ended: 3, changed: 0, unchanged: 0 })
    await expect(
      changes.request({
        tenantId,
        actorId: ANA,
        body: {
          ...ownCbs(),
          definition: { ...ownCbs().definition, precedence: 'default' },
        },
      }),
    ).rejects.toBeInstanceOf(RuleChangeRefused)
  })
})
