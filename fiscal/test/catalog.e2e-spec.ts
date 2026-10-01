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
import { CatalogAdoptionClash, type CatalogPublication, FiscalCatalog } from '../src/catalog'
import { DECLARED_NCM, goodsPackage, issPackage } from '../src/legacy-packages'
import { DEMO_WORKSPACE, scenarios } from '../src/legacy-scenarios'
import {
  approvedPhase41Publication,
  approvedPhase41Source,
  PHASE41_CATALOG_IDENTITY,
  PHASE41_FIXTURE_ID,
} from '../src/phase41-approved-scenario'
import { blendPackage, pisCofinsNormalPackage, simplesMeiPackage } from '../src/regime-packages'
import { regimeScenarios } from '../src/regime-scenarios'
import { buildRtcPackage } from '../src/rtc-package'
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

describe('formulas as data (Phase 83, ADR 0071)', () => {
  const OPERATION = 'phase83-worked-example'
  const expressionRule = (
    code: string,
    numerator: string,
    base: unknown,
  ): CatalogPublication['rules'][number] => ({
    ruleKey: `phase83.${code.toLowerCase()}`,
    version: 1,
    group: 'legacy',
    code,
    precedence: 'operation',
    priority: 500,
    model: '55',
    environment: 'simulation',
    operation: OPERATION,
    effectiveFrom: '2026-01-01',
    rate: { numerator, denominator: '100' },
    formula: 'EXPRESSION',
    expression: { version: 'formula-v1', base } as never,
    sourceLocator: `worked example ${code}`,
  })
  const publication = (rules: CatalogPublication['rules'], label: string): CatalogPublication => {
    const base = approvedPhase41Publication({ byteSize: ARTIFACT_BYTES })
    return {
      ...base,
      authority: 'Horizon worked example (Phase 83)',
      artifact: undefined,
      bytes: Buffer.from(`phase83 ${label}`),
      entries: base.entries.filter((entry) => entry.family === 'ncm'),
      rules,
    }
  }
  const ipi = expressionRule('IPI', '10', { line: 'net' })
  const icms = expressionRule('ICMS', '18', {
    grossUp: {
      base: { sum: [{ line: 'net' }, { component: 'IPI' }] },
      rate: { rate: { numerator: '18', denominator: '100' } },
    },
  })

  it('refuses to publish a package whose components read each other in a cycle', async () => {
    const circular = expressionRule('IPI', '10', { component: 'ICMS' })
    await expect(publisher.publish(publication([circular, icms], 'cycle'))).rejects.toThrow(/cycle/)
  })

  it('publishes, adopts and calculates tax on tax through the store', async () => {
    const published = await publisher.publish(publication([icms, ipi], 'worked'))
    const tenantId = await workspace()
    await catalog.adopt({
      tenantId,
      packageId: published.packageId,
      effectiveFrom: '2026-01-01',
      reviewedBy: 'workspace-owner',
      interpretation: 'A worked example of tax on tax, not law.',
      actorId: 'owner:test',
      reason: 'Phase 83 e2e',
    })
    const result = await calculations.preview({ ...inputFor(tenantId), operation: OPERATION })
    if (!result.supported) throw new Error(JSON.stringify(result))
    expect(result.explanation.templateVersion).toBe('fiscal-explanation-v2')
    expect(
      result.lines[0]?.components.legacy.map((component) => [
        component.code,
        component.base.amount,
        component.amount.amount,
        component.outcome,
      ]),
    ).toEqual([
      ['IPI', '10000', '1000', 'levied'],
      ['ICMS', '13415', '2415', 'levied'],
    ])
    expect(result.lines[0]?.components.legacy[1]?.steps?.[0]?.step).toBe(
      'base = grossUp((line.net + IPI), 18/100)',
    )
  })

  it('refuses a workspace import whose formula reads a component no rule defines', async () => {
    const tenantId = await workspace()
    const source = approvedPhase41Source(tenantId, {
      byteSize: ARTIFACT_BYTES,
      storageUri: 'file://t',
    })
    await expect(
      store.importSource({
        ...source,
        artifact: undefined,
        bytes: Buffer.from('phase83 unknown component'),
        rules: [
          {
            ...expressionRule('ICMS', '18', { component: 'IPI' }),
            precedence: 'operation',
          } as never,
        ],
      }),
    ).rejects.toThrow(/no rule of the package/)
  })
})

describe('IBS and CBS by tax classification (Phase 84, ADR 0072)', () => {
  const calculatorClass = (
    code: string,
    reduction: string,
    treatmentId = 3,
  ): Parameters<typeof buildRtcPackage>[0]['classes'][number] => ({
    code,
    description: `class ${code}`,
    situation: code.slice(0, 3),
    treatmentId,
    treatment: 'test',
    startsOn: '2026-01-01',
    endsOn: null,
    documentModels: ['55', '65'],
    reductions: { CBS: reduction, IBSUF: reduction, IBSMun: reduction },
  })
  const built = buildRtcPackage({
    label: 'rtc.e2e',
    classes: [
      calculatorClass('000001', '0'),
      calculatorClass('200032', '60'),
      calculatorClass('410001', '0', 18),
    ],
    ncms: [],
    rates: { CBS: '0.9', IBSUF: '0.1', IBSMun: '0' },
    window: { effectiveFrom: '2026-01-01', effectiveTo: '2027-01-01' },
  })
  const classified = (tenantId: string, classTrib: string | undefined, unitPrice: string) => {
    const [line] = fixture.input.lines
    if (!line) throw new Error('fixture line missing')
    return {
      ...inputFor(tenantId),
      operation: 'sale',
      lines: [
        {
          ...line,
          unitPrice,
          classifications: { ...line.classifications, ...(classTrib ? { classTrib } : {}) },
        },
      ],
    }
  }
  const components = (result: Awaited<ReturnType<FiscalCalculations['preview']>>) => {
    if (!result.supported) throw new Error(JSON.stringify(result))
    return result.lines[0]?.components.ibsCbs.map((component) => [
      component.code,
      component.amount.amount,
      component.outcome,
      component.rounding.mode,
    ])
  }

  it('publishes the package from the calculator, adopts it and previews a reduced line', async () => {
    const base = approvedPhase41Publication({ byteSize: ARTIFACT_BYTES })
    const published = await publisher.publish({
      ...base,
      authority: 'Calculadora RTC (Phase 84 e2e)',
      artifact: undefined,
      bytes: Buffer.from('phase84 e2e'),
      entries: [...built.entries, ...base.entries.filter((entry) => entry.family === 'ncm')],
      rules: built.rules as never,
    })
    const tenantId = await workspace()
    await catalog.adopt({
      tenantId,
      packageId: published.packageId,
      effectiveFrom: '2026-01-01',
      reviewedBy: 'workspace-owner',
      interpretation: 'IBS and CBS 2026 by tax classification.',
      actorId: 'owner:test',
      reason: 'Phase 84 e2e',
    })
    // 60% less: CBS 0,36% and IBS UF 0,04% over 1.000,00, as the official calculator gives.
    expect(components(await calculations.preview(classified(tenantId, '200032', '1000')))).toEqual([
      ['CBS', '360', 'levied', 'half-even'],
      ['IBS_MUN', '0', 'levied', 'half-even'],
      ['IBS_UF', '40', 'levied', 'half-even'],
    ])
    // 5,00 × 0,9% = 0,045: half to even keeps 0,04.
    expect(
      components(await calculations.preview(classified(tenantId, '000001', '5')))?.[0],
    ).toEqual(['CBS', '4', 'levied', 'half-even'])
    expect(
      components(await calculations.preview(classified(tenantId, '410001', '1000')))?.[0],
    ).toEqual(['CBS', '0', 'exempt', 'half-even'])
    // Without a classification the package has nothing to say.
    expect(await calculations.preview(classified(tenantId, undefined, '1000'))).toMatchObject({
      supported: false,
    })
  })
})

describe('the legacy taxes, bounded by reviewed scenarios (Phase 85, ADR 0072)', () => {
  it('publishes the packages, adopts them and reproduces every fixture through the store', async () => {
    const manifest = JSON.parse(
      await readFile(
        new URL('../../docs/tax-phase85-source-manifest.json', import.meta.url),
        'utf8',
      ),
    )
    const packs = [
      goodsPackage(manifest, new Map([[DECLARED_NCM, '6.5']]), [DECLARED_NCM]),
      issPackage(manifest),
    ]
    const tenantId = await workspace(DEMO_WORKSPACE)
    for (const pack of packs) {
      const { label: _label, ...publication } = pack
      const published = await publisher.publish(publication)
      await catalog.adopt({
        tenantId,
        packageId: published.packageId,
        effectiveFrom: '2026-01-01',
        reviewedBy: 'workspace-owner',
        interpretation: 'The Phase 85 declared scenarios.',
        actorId: 'owner:test',
        reason: 'Phase 85 e2e',
      })
    }
    for (const scenario of scenarios()) {
      const fixture = JSON.parse(
        await readFile(new URL(`../fixtures/phase85/${scenario.id}.json`, import.meta.url), 'utf8'),
      )
      const result = await calculations.preview(scenario.input)
      expect(canonicalJson(result).toString(), `${scenario.id} through the store`).toBe(
        canonicalJson(fixture.expectedResult).toString(),
      )
    }
    // Outside the declared scenarios, a contributor buying for its own use: the rules that exist
    // (IPI) still calculate, and the ICMS they cannot give is the support matrix's to refuse.
    const [f6] = scenarios().filter((scenario) => scenario.id.includes('f6'))
    const [line] = f6?.input.lines ?? []
    if (!f6 || !line) throw new Error('F6 is declared')
    const ownUse = await calculations.preview({
      ...f6.input,
      lines: [{ ...line, taxFacts: { ipiTaxpayer: 'true', destinationUse: 'consumption' } }],
    })
    if (!ownUse.supported) throw new Error(JSON.stringify(ownUse))
    expect(ownUse.lines[0]?.components.legacy.map((component) => component.code)).toEqual(['IPI'])
  })
})

describe('regimes and the blend (Phase 86)', () => {
  it('publishes and adopts the regime packages, reproduces every fixture, and replays a June lock', async () => {
    const sources = (
      await Promise.all(
        ['82', '85', '86'].map(
          async (phase) =>
            JSON.parse(
              await readFile(
                new URL(`../../docs/tax-phase${phase}-source-manifest.json`, import.meta.url),
                'utf8',
              ),
            ).sources,
        ),
      )
    ).flat()
    const manifest = { sources }
    const packs = [
      goodsPackage(manifest, new Map([[DECLARED_NCM, '6.5']]), [DECLARED_NCM]),
      issPackage(manifest),
      pisCofinsNormalPackage(manifest),
      simplesMeiPackage(manifest),
      blendPackage(manifest),
    ]
    const tenantId = await workspace(DEMO_WORKSPACE)
    for (const pack of packs) {
      const { label: _label, ...publication } = pack
      const published = await publisher.publish(publication)
      // The Phase 85 packages may already be adopted by the test before this one.
      await catalog
        .adopt({
          tenantId,
          packageId: published.packageId,
          effectiveFrom: '2026-01-01',
          reviewedBy: 'workspace-owner',
          interpretation: 'The Phase 85 and 86 declared scenarios.',
          actorId: 'owner:test',
          reason: 'Phase 86 e2e',
        })
        .catch((error: unknown) => {
          if (!(error instanceof Error && /already adopted/.test(error.message))) throw error
        })
    }
    for (const scenario of regimeScenarios()) {
      const fixture = JSON.parse(
        await readFile(new URL(`../fixtures/phase86/${scenario.id}.json`, import.meta.url), 'utf8'),
      )
      const result = await calculations.preview(scenario.input)
      expect(canonicalJson(result).toString(), `${scenario.id} through the store`).toBe(
        canonicalJson(fixture.expectedResult).toString(),
      )
    }
    // A sale locked on 30 June as Simples replays as it was, whatever the issuer became on 1 July.
    const [june] = regimeScenarios().filter((scenario) => scenario.id.includes('g7a'))
    if (!june) throw new Error('G7a is declared')
    const documentId = randomUUID()
    await insertDraft(tenantId, documentId, june.input.issuerEstablishmentId)
    const locked = await calculations.validateDocument({
      tenantId,
      documentId,
      actorId: 'issuer:test',
      calculationInput: june.input,
    })
    expect(locked.supported).toBe(true)
    expect(await calculations.replay(tenantId, documentId)).toEqual(locked)
  })
})

describe('the lock answers to the support matrix (Phase 87, ADR 0072)', () => {
  it('locks an approved scenario and publishes its components, and refuses one no evidence covers', async () => {
    const tenantId = await workspace(DEMO_WORKSPACE)
    const [g4] = regimeScenarios().filter((scenario) => scenario.id.includes('g4'))
    const [f6] = scenarios().filter((scenario) => scenario.id.includes('f6'))
    const [line] = f6?.input.lines ?? []
    if (!g4 || !f6 || !line) throw new Error('G4 and F6 are declared')

    const approved = randomUUID()
    await insertDraft(tenantId, approved, g4.input.issuerEstablishmentId)
    const locked = await calculations.validateDocument({
      tenantId,
      documentId: approved,
      actorId: 'issuer:test',
      calculationInput: g4.input,
    })
    expect(locked.supported).toBe(true)
    const [event] = await administrator`select payload from fiscal_outbox
      where tenant_id = ${tenantId} and event_type = 'fiscal.calculation.locked'
        and payload->>'documentId' = ${approved}`
    expect(
      ((event?.payload.components ?? []) as { code: string; amount: string }[]).map((component) => [
        component.code,
        component.amount,
      ]),
    ).toEqual([
      ['ICMS', '6836'],
      ['COFINS', '2367'],
      ['PIS', '514'],
    ])

    // A contributor buying for its own use: only IPI calculates, and nothing approved says so.
    const outside = randomUUID()
    await insertDraft(tenantId, outside, f6.input.issuerEstablishmentId)
    const refused = await calculations.validateDocument({
      tenantId,
      documentId: outside,
      actorId: 'issuer:test',
      calculationInput: {
        ...f6.input,
        lines: [{ ...line, taxFacts: { ipiTaxpayer: 'true', destinationUse: 'consumption' } }],
      },
    })
    expect(refused).toMatchObject({ supported: false, code: 'UNSUPPORTED_SCENARIO' })
    expect(refused.supported ? '' : refused.missingDimension).toMatch(/IPI/)
    const [draft] = await administrator`select status from fiscal_documents
      where tenant_id = ${tenantId} and id = ${outside}`
    expect(draft?.status).toBe('draft')
  })
})
