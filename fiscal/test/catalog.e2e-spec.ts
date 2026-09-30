import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { FiscalCalculationInput } from '@horizon/contracts'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FiscalCalculations } from '../src/calculations'
import { canonicalJson } from '../src/canonical-json'
import { CatalogAdoptionClash, FiscalCatalog } from '../src/catalog'
import {
  approvedPhase41Publication,
  approvedPhase41Source,
  PHASE41_CATALOG_IDENTITY,
  PHASE41_FIXTURE_ID,
} from '../src/phase41-approved-scenario'
import { FiscalRuleStore } from '../src/rule-store'

/** Phase 82 (ADR 0070): tax law as a catalogue every workspace reads, none writes, and each adopts. */

const ARTIFACT_BYTES = 346_174_581

let container: StartedPostgreSqlContainer
let administrator: ReturnType<typeof postgres>
let app: ReturnType<typeof postgres>
let publisher: FiscalCatalog
let catalog: FiscalCatalog
let store: FiscalRuleStore
let calculations: FiscalCalculations
let fixture: { input: FiscalCalculationInput; expectedResult: unknown }
let packageId: string

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('horizon_fiscal_catalog_test')
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
  app = postgres(appUrl, { max: 2 })
  publisher = new FiscalCatalog(migrationUrl)
  catalog = new FiscalCatalog(appUrl)
  store = new FiscalRuleStore(appUrl)
  calculations = new FiscalCalculations(appUrl, randomBytes(32), store)
  fixture = JSON.parse(
    await readFile(
      new URL('../fixtures/rtc-v0057-model55-normal-sale-sp-2026-01.json', import.meta.url),
      'utf8',
    ),
  )
  const published = await publisher.publish(
    approvedPhase41Publication({ byteSize: ARTIFACT_BYTES }),
    PHASE41_CATALOG_IDENTITY,
  )
  packageId = published.packageId
}, 120_000)

afterAll(async () => {
  await Promise.allSettled([
    calculations?.close(),
    store?.close(),
    catalog?.close(),
    publisher?.close(),
    app?.end(),
    administrator?.end(),
    container?.stop(),
  ])
})

async function workspace(tenantId: string = randomUUID()): Promise<string> {
  await administrator`insert into tenants (id) values (${tenantId}) on conflict do nothing`
  return tenantId
}

const adopt = (tenantId: string, effectiveFrom = '2026-01-01') =>
  catalog.adopt({
    tenantId,
    packageId,
    effectiveFrom,
    reviewedBy: 'workspace-owner',
    interpretation: 'The pinned RTC V0057 fixture scenario, as approved in Phase 41.',
    fixtureIds: [PHASE41_FIXTURE_ID],
    actorId: 'owner:test',
    reason: 'Adopting the catalogue version of the approved scenario',
  })

/** The fixture's own input, for another workspace. */
const inputFor = (
  tenantId: string,
  issueDate = fixture.input.issueDate,
): FiscalCalculationInput => ({
  ...fixture.input,
  tenantId,
  issueDate,
})

describe('the shared catalogue (Phase 82)', () => {
  it('keeps Phase 41’s package and rule identifiers', () => {
    expect(packageId).toBe(PHASE41_CATALOG_IDENTITY.packageId)
  })

  it('is read by the application and written by nobody through it', async () => {
    expect((await app`select count(*)::int as rules from fiscal_catalog_rules`)[0]?.rules).toBe(3)
    await expect(
      app`insert into fiscal_catalog_packages (id, authority, source_uri, package_digest,
        published_at, effective_from, source_bytes, publisher)
        values (${randomUUID()}, 'forged', 'https://example.invalid', ${'a'.repeat(64)},
          '2026-01-01', '2026-01-01', ${Buffer.from('x')}, 'workspace')`,
    ).rejects.toThrow(/permission denied/)
    await expect(app`delete from fiscal_catalog_rules`).rejects.toThrow(/permission denied/)
  })

  it('refuses a rule scoped to one workspace’s establishment', async () => {
    const publication = approvedPhase41Publication({ byteSize: ARTIFACT_BYTES })
    const [rule] = publication.rules
    if (!rule) throw new Error('the publication has no rule')
    await expect(
      publisher.publish({
        ...publication,
        bytes: Buffer.from('another package'),
        artifact: undefined,
        rules: [
          {
            ...rule,
            ruleKey: 'scoped',
            precedence: 'establishment',
            issuerEstablishmentId: randomUUID(),
          },
        ],
      }),
    ).rejects.toThrow(/law/)
  })
})

describe('a workspace adopting the catalogue', () => {
  it('reproduces the approved result byte for byte from the catalogue', async () => {
    await adopt(await workspace(fixture.input.tenantId))
    const result = await calculations.preview(fixture.input)
    expect(canonicalJson(result).toString()).toBe(canonicalJson(fixture.expectedResult).toString())
  })

  it('calculates the same for every workspace on the same version', async () => {
    const [first, second] = [await workspace(), await workspace()]
    await adopt(first)
    await adopt(second)
    const [a, b] = await Promise.all([
      calculations.preview(inputFor(first)),
      calculations.preview(inputFor(second)),
    ])
    if (!a.supported || !b.supported) throw new Error('both should be supported')
    expect(a.rulesDigest).toBe(b.rulesDigest)
    expect(a.lines).toEqual(b.lines)
  })

  it('is unsupported until it adopts, and again once it withdraws', async () => {
    const tenantId = await workspace()
    expect(await calculations.preview(inputFor(tenantId))).toMatchObject({ supported: false })
    await adopt(tenantId)
    expect((await calculations.preview(inputFor(tenantId))).supported).toBe(true)
    await catalog.withdraw({
      tenantId,
      packageId,
      actorId: 'owner:test',
      reason: 'Withdrawn to test that it stops applying',
    })
    expect(await calculations.preview(inputFor(tenantId))).toMatchObject({ supported: false })
  })

  it('applies an adoption only from its own date', async () => {
    const tenantId = await workspace()
    await adopt(tenantId, '2026-10-01')
    expect(await calculations.preview(inputFor(tenantId, '2026-09-30'))).toMatchObject({
      supported: false,
    })
    expect((await calculations.preview(inputFor(tenantId, '2026-10-01'))).supported).toBe(true)
  })

  it('keeps a locked calculation replaying after the adoption is withdrawn', async () => {
    const tenantId = await workspace()
    await adopt(tenantId)
    const documentId = randomUUID()
    await insertDraft(tenantId, documentId, fixture.input.issuerEstablishmentId)
    const locked = await calculations.validateDocument({
      tenantId,
      documentId,
      actorId: 'issuer:test',
      calculationInput: inputFor(tenantId),
    })
    expect(locked.supported).toBe(true)
    await catalog.withdraw({ tenantId, packageId, actorId: 'owner:test', reason: 'Law changed' })
    expect(await calculations.replay(tenantId, documentId)).toEqual(locked)
  })

  it('refuses an adoption that would tie with its own active copy, until the copy is retired', async () => {
    const tenantId = await workspace()
    const imported = await store.importSource(
      approvedPhase41Source(tenantId, { byteSize: ARTIFACT_BYTES, storageUri: 'file://test' }),
    )
    await store.reviewPackage({
      tenantId,
      packageId: imported.packageId,
      approved: true,
      reviewedBy: 'workspace-owner',
      reviewedAt: '2026-09-22T13:30:00.000Z',
      interpretation: 'The workspace’s own copy of the approved scenario.',
      fixtureIds: [PHASE41_FIXTURE_ID],
    })
    for (const ruleId of imported.ruleIds)
      await store.activateRule({
        tenantId,
        ruleId,
        action: 'activate',
        actorId: 'owner:test',
        reason: 'Own copy',
      })
    await expect(adopt(tenantId)).rejects.toBeInstanceOf(CatalogAdoptionClash)
    for (const ruleId of imported.ruleIds)
      await store.activateRule({
        tenantId,
        ruleId,
        action: 'deactivate',
        actorId: 'owner:test',
        reason: 'Retired in favour of the catalogue (Phase 82)',
      })
    await adopt(tenantId)
    expect((await calculations.preview(inputFor(tenantId))).supported).toBe(true)
  })

  it('records every adoption and withdrawal in the workspace’s audit chain', async () => {
    const tenantId = await workspace()
    await adopt(tenantId)
    await catalog.withdraw({ tenantId, packageId, actorId: 'owner:test', reason: 'Audit test' })
    const actions = await administrator<
      { action: string }[]
    >`select action from fiscal_audit_entries
      where tenant_id = ${tenantId} order by sequence`
    expect(actions.map((row) => row.action)).toEqual([
      'catalog.package-adopted',
      'catalog.package-withdrawn',
    ])
  })
})

async function insertDraft(tenantId: string, documentId: string, establishmentId: string) {
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
    ${documentId}, ${tenantId}, ${intentId}, '55', 'simulation', ${establishmentId}, 1,
    ${'d'.repeat(64)}, ${Buffer.from('encrypted-placeholder')}
  )`
}
