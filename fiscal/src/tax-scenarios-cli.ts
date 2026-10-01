import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { FiscalCalculations } from './calculations'
import { canonicalJson } from './canonical-json'
import { FiscalCatalog } from './catalog'
import { DECLARED_NCM, goodsPackage, issPackage, type SourceManifest } from './legacy-packages'
import {
  expectedResult,
  type Fixture,
  fixtureDigest,
  type Scenario,
  scenarios,
} from './legacy-scenarios'
import { blendPackage, pisCofinsNormalPackage, simplesMeiPackage } from './regime-packages'
import { regimeScenarios } from './regime-scenarios'
import { reviewedPackages } from './reviewed-packages'
import { changeSummary, withRuleChanges } from './rule-change-cli'
import { deterministicUuid } from './rule-rows'
import { FiscalRuleStore } from './rule-store'
import { buildSupportMatrix, supportEvidence } from './tax-support'

/**
 * Phases 85 and 86 (ADR 0072): the reviewed tax scenarios, `--phase 85` (the default) or `86`.
 *   fixtures                                   build every fixture; an unchanged one keeps its approval
 *   approve --fixture <id> --by <who> --scope <text>   only on the workspace owner's word
 *   publish                                    as the migration role (DATABASE_MIGRATION_URL)
 *   adopt --tenant <id> --actor <who>          the packages, citing the approved fixtures
 *   verify                                     every approved fixture, previewed through the store
 *   matrix                                     fiscal/support-matrix.json, from the oracle reports and approved fixtures
 */

const REPOSITORY = resolve(__dirname, '..', '..')
const MATRIX = join(REPOSITORY, 'fiscal/support-matrix.json')

const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? undefined : process.argv[index + 1]
}

const PHASE = option('phase') ?? '85'
if (PHASE !== '85' && PHASE !== '86') throw new Error('--phase is 85 or 86')
const FIXTURES = join(REPOSITORY, `fiscal/fixtures/phase${PHASE}`)
const SCENARIOS: () => Scenario[] = PHASE === '85' ? scenarios : regimeScenarios
const required = (name: string): string => {
  const found = option(name)
  if (!found) throw new Error(`--${name} is required`)
  return found
}
const env = (name: string): string => {
  const found = process.env[name]
  if (!found) throw new Error(`${name} is required`)
  return found
}

/** Every package a phase's fixtures are calculated with, and the ones the phase publishes. */
async function packageSet() {
  const { phase85, phase86 } = await reviewedPackages(REPOSITORY)
  if (PHASE === '85') return { all: phase85, own: phase85 }
  return { all: [...phase85, ...phase86], own: phase86 }
}

async function packages() {
  return (await packageSet()).all
}

async function readFixtures(): Promise<Fixture[]> {
  if (!existsSync(FIXTURES)) return []
  const names = (await readdir(FIXTURES)).filter((name) => name.endsWith('.json')).sort()
  return Promise.all(
    names.map(async (name) => JSON.parse(await readFile(join(FIXTURES, name), 'utf8')) as Fixture),
  )
}

const packageDigest = (pack: { bytes: Buffer }) =>
  createHash('sha256').update(pack.bytes).digest('hex')

async function fixtures(): Promise<unknown> {
  const built = await packages()
  const prior = new Map((await readFixtures()).map((fixture) => [fixture.fixtureId, fixture]))
  await mkdir(FIXTURES, { recursive: true })
  const summary = []
  for (const scenario of SCENARIOS()) {
    const unsigned: Omit<Fixture, 'approval'> = {
      schemaVersion: 1,
      fixtureId: scenario.id,
      title: scenario.title,
      covers: scenario.covers,
      packages: built.map((pack) => ({ label: pack.label, packageDigest: packageDigest(pack) })),
      input: scenario.input,
      expectedResult: expectedResult(scenario, built),
    }
    const digest = fixtureDigest(unsigned)
    const kept = prior.get(scenario.id)?.approval
    // An approval signs one exact fixture; any change to it asks for a new review.
    const approval = kept && kept.fixtureDigest === digest ? kept : null
    await writeFile(
      join(FIXTURES, `${scenario.id}.json`),
      `${JSON.stringify({ ...unsigned, approval }, null, 2)}\n`,
    )
    summary.push({
      fixtureId: scenario.id,
      supported: unsigned.expectedResult.supported,
      digest,
      approved: approval !== null,
    })
  }
  return summary
}

async function approve(): Promise<unknown> {
  const id = required('fixture')
  const path = join(FIXTURES, `${id}.json`)
  const fixture = JSON.parse(await readFile(path, 'utf8')) as Fixture
  const { approval: _previous, ...unsigned } = fixture
  const approval = {
    approvedBy: required('by'),
    approvedAt: new Date().toISOString(),
    scope: required('scope'),
    fixtureDigest: fixtureDigest(unsigned),
  }
  await writeFile(path, `${JSON.stringify({ ...unsigned, approval }, null, 2)}\n`)
  return { fixtureId: id, approval }
}

async function publish(): Promise<unknown> {
  const catalog = new FiscalCatalog(env('DATABASE_MIGRATION_URL'), 300_000)
  try {
    const published = []
    for (const pack of (await packageSet()).own) {
      const { label, ...publication } = pack
      published.push({ label, ...(await catalog.publish(publication)) })
    }
    return published
  } finally {
    await catalog.close()
  }
}

/**
 * Asks for each package of the phase to be adopted, citing the approved fixtures; another
 * person approves the requests with `approve` (Phase 88, ADR 0074).
 */
async function requestAdoption(): Promise<unknown> {
  const approved = (await readFixtures()).filter((fixture) => fixture.approval)
  if (approved.length === 0) throw new Error('No fixture is approved: nothing to adopt')
  const packages = (await packageSet()).own
  return withRuleChanges(env('DATABASE_URL'), env('FISCAL_ARTIFACT_KEY_HEX'), async (changes) => {
    const requests = []
    for (const pack of packages) {
      const digest = packageDigest(pack)
      const cited = approved
        .filter((fixture) => fixture.packages.some((entry) => entry.packageDigest === digest))
        .map((fixture) => fixture.fixtureId)
      const change = await changes.request({
        tenantId: required('tenant'),
        actorId: required('requested-by'),
        body: {
          kind: 'adopt-package',
          packageId: deterministicUuid('catalog', pack.authority, digest),
          effectiveFrom: '2026-01-01',
          interpretation: `${pack.label}, as reviewed in the approved Phase ${PHASE} fixtures.`,
          fixtureIds: cited,
          reason:
            PHASE === '85'
              ? 'Phase 85: the legacy taxes, bounded by reviewed scenarios'
              : 'Phase 86: regimes and the blend',
        },
      })
      requests.push({ label: pack.label, ...changeSummary(change) })
    }
    return requests
  })
}

/** Approves the pending adoption request of each package of the phase. */
async function approveAdoption(): Promise<unknown> {
  const packages = (await packageSet()).own
  const tenantId = required('tenant')
  return withRuleChanges(env('DATABASE_URL'), env('FISCAL_ARTIFACT_KEY_HEX'), async (changes) => {
    const listed = await changes.packages(tenantId)
    const decisions = []
    for (const pack of packages) {
      const packageId = deterministicUuid('catalog', pack.authority, packageDigest(pack))
      const changeId = listed.find((entry) => entry.id === packageId)?.pendingChangeId
      if (!changeId) throw new Error(`${pack.label} has no pending adoption request`)
      const change = await changes.decide({
        tenantId,
        actorId: required('approved-by'),
        holdsApproval: true,
        changeId,
        outcome: 'approved',
      })
      decisions.push({ label: pack.label, ...changeSummary(change) })
    }
    return decisions
  })
}

async function verify(): Promise<unknown> {
  const store = new FiscalRuleStore(env('DATABASE_URL'))
  const calculations = new FiscalCalculations(
    env('DATABASE_URL'),
    Buffer.from(env('FISCAL_ARTIFACT_KEY_HEX'), 'hex'),
    store,
  )
  try {
    const results = []
    for (const fixture of await readFixtures()) {
      if (!fixture.approval) {
        results.push({ fixtureId: fixture.fixtureId, skipped: 'not approved' })
        continue
      }
      const result = await calculations.preview(fixture.input)
      const matches =
        canonicalJson(result).toString() === canonicalJson(fixture.expectedResult).toString()
      results.push({ fixtureId: fixture.fixtureId, matches })
    }
    if (results.some((result) => 'matches' in result && !result.matches)) process.exitCode = 1
    return results
  } finally {
    await calculations.close()
    await store.close()
  }
}

async function matrix(): Promise<unknown> {
  const generated = buildSupportMatrix(await supportEvidence(REPOSITORY))
  await writeFile(MATRIX, `${JSON.stringify(generated, null, 2)}\n`)
  // Committed as the repository's formatter writes it, so lint and the drift test agree.
  execFileSync('npx', ['biome', 'format', '--write', MATRIX], { cwd: join(REPOSITORY, 'fiscal') })
  return {
    rows: generated.rows.length,
    oracle: generated.rows.filter((row) => row.evidence.kind === 'oracle').length,
    approvedFixtures: generated.rows.filter((row) => row.evidence.kind === 'approved-fixture')
      .length,
  }
}

const actions: Record<string, () => Promise<unknown>> = {
  fixtures,
  approve,
  publish,
  'request-adoption': requestAdoption,
  'approve-adoption': approveAdoption,
  verify,
  matrix,
}

const named = process.argv.slice(2).find((argument) => argument in actions)
const action = named ? actions[named] : undefined
if (!action) {
  process.stderr.write(
    `usage: tax-scenarios-cli <${Object.keys(actions).join('|')}> [--phase 85|86]\n`,
  )
  process.exit(2)
}
action()
  .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
