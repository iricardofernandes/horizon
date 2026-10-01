import { randomUUID } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { FiscalCalculationInput, FiscalCalculationOutcome } from '@horizon/contracts'
import postgres from 'postgres'
import { FiscalCalculations } from './calculations'
import { FiscalCatalog } from './catalog'
import { regimeScenarios } from './regime-scenarios'
import { reviewedPackages } from './reviewed-packages'
import { FiscalRuleChanges } from './rule-changes'
import { FiscalRuleStore } from './rule-store'
import { buildSupportMatrix, supportEvidence } from './tax-support'

/**
 * Phase 89, in isolation: the reform's 2027 rates are not published, so the hypothetical
 * package Phase 84 proved against the official calculator is published here, in a throwaway
 * database, and never in a catalogue a workspace reads. It shows:
 * - the same operation dated 2026, 2027, 2029 and 2033, each with its date's regime;
 * - a document locked before the next version replays byte for byte after it is adopted.
 *
 * Run by `scripts/phase-o-2027.mjs`, which creates and removes the database. It refuses any
 * database not named `horizon_phase89_isolated`.
 */

const THROWAWAY = 'horizon_phase89_isolated'
const REPOSITORY = resolve(__dirname, '..', '..')
const REQUESTER = 'phase89:requester'
const APPROVER = 'phase89:approver'
const DATES = ['2026-10-15', '2027-03-15', '2029-03-15', '2033-03-15'] as const
/**
 * A class taxed in both years' packages (medical devices, at 60% less). The 2027 package does
 * not model the regular rate: in 2027 code 000001 means the Imposto Seletivo with calculation.
 */
const CLASS_TRIB = '200030'

const env = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

type RtcPackage = { bytes: Buffer; [key: string]: unknown }

async function loadRtcPackage(path: string): Promise<RtcPackage> {
  const parsed = JSON.parse(await readFile(path, 'utf8'))
  return { ...parsed, bytes: Buffer.from(JSON.stringify(parsed.bytes)) }
}

function publicationOf(pack: RtcPackage) {
  const {
    calculatorVersion: _v,
    hypothetical: _h,
    rates: _r,
    window: _w,
    excluded: _e,
    ...publication
  } = pack
  return publication as never
}

function summary(outcome: FiscalCalculationOutcome) {
  if (!outcome.supported)
    return {
      supported: false,
      code: outcome.code,
      missingDimension: outcome.missingDimension ?? null,
    }
  return {
    supported: true,
    components: outcome.lines.flatMap((line) =>
      [...line.components.legacy, ...line.components.ibsCbs].map((component) => ({
        code: component.code,
        amount: component.amount.amount,
        outcome: component.outcome ?? 'levied',
        rate: `${component.rate.numerator}/${component.rate.denominator}`,
        rule: `${component.rule.id}@${component.rule.version}`,
        source: component.source.section,
      })),
    ),
    resultDigest: outcome.resultDigest,
  }
}

async function main(): Promise<void> {
  const adminUrl = env('DATABASE_ADMIN_URL')
  if (new URL(adminUrl).pathname !== `/${THROWAWAY}`)
    throw new Error(`Refused: this run publishes a hypothetical package, only into ${THROWAWAY}`)
  const migrationUrl = env('DATABASE_MIGRATION_URL')
  const appUrl = env('DATABASE_URL')
  const key = Buffer.from(env('FISCAL_ARTIFACT_KEY_HEX'), 'hex')
  const packages = join(REPOSITORY, '.artifacts/fiscal/packages')
  const admin = postgres(adminUrl, { max: 1 })
  const publisher = new FiscalCatalog(migrationUrl, 300_000)
  const store = new FiscalRuleStore(appUrl)

  // The repository's matrix, with the hypothetical 2027 oracle run beside the real one.
  const evidence = await supportEvidence(REPOSITORY)
  const drills = join(REPOSITORY, 'docs/drills')
  const hypothetical = (await readdir(drills))
    .filter((name) => /-phase84-oracle-hypothetical-2027\.json$/.test(name))
    .sort()
  const matrix = buildSupportMatrix({
    ...evidence,
    oracleReports: [
      ...evidence.oracleReports,
      ...(await Promise.all(
        hypothetical.map(async (name) => ({
          reference: `docs/drills/${name}`,
          bytes: await readFile(join(drills, name)),
        })),
      )),
    ],
  })
  const calculations = new FiscalCalculations(appUrl, key, store, matrix)
  const changes = new FiscalRuleChanges(appUrl, key, store, matrix)
  const record: Record<string, unknown> = {
    phase: 89,
    kind: 'isolated-2027',
    hypothetical:
      'The 2027 IBS/CBS rates are the nominal rates Phase 84 stated, never published by the Senate; this run used a throwaway database.',
    ranAt: new Date().toISOString(),
  }
  try {
    const published: Record<string, string> = {}
    const { phase85, phase86 } = await reviewedPackages(REPOSITORY)
    for (const pack of [...phase85, ...phase86]) {
      const { label, ...publication } = pack
      published[label] = (await publisher.publish(publication)).packageId
    }
    for (const year of ['2026', 'hypothetical-2027']) {
      const pack = await loadRtcPackage(join(packages, `rtc-v0059-ibs-cbs-${year}.json`))
      published[`rtc-v0059-${year}`] = (await publisher.publish(publicationOf(pack))).packageId
    }
    record.published = Object.keys(published)

    const tenantId = randomUUID()
    await admin`insert into tenants (id) values (${tenantId})`
    const adopt = async (label: string) => {
      const packageId = published[label]
      if (!packageId) throw new Error(`${label} was not published`)
      const change = await changes.request({
        tenantId,
        actorId: REQUESTER,
        body: {
          kind: 'adopt-package',
          packageId,
          effectiveFrom: '2026-01-01',
          interpretation: `${label}, adopted in the Phase 89 isolated run.`,
          reason: 'Phase 89: the regime of each date, in isolation',
          impactMonths: 12,
        },
      })
      const decided = await changes.decide({
        tenantId,
        actorId: APPROVER,
        holdsApproval: true,
        changeId: change.id,
        outcome: 'approved',
      })
      return {
        label,
        diff: change.diff.counts,
        impact: {
          examined: change.impact.examined,
          changed: change.impact.changed.length,
          unsupported: change.impact.unsupported.length,
          unchanged: change.impact.unchanged,
        },
        decision: decided.status,
      }
    }
    const adoptions = []
    for (const label of [
      'rtc-v0059-2026',
      ...phase85.map((pack) => pack.label),
      // Phase 86's PIS/Cofins for a normal issuer, and the 2029–2032 blend; not Simples/MEI.
      labelOf(phase86, 0),
      labelOf(phase86, 2),
    ])
      adoptions.push(await adopt(label))

    const [g4] = regimeScenarios().filter((scenario) => scenario.id === 'phase86-g4-real-resale')
    if (!g4) throw new Error('G4 is declared')
    const inputOn = (
      issueDate: string,
      classTrib: string | null = CLASS_TRIB,
    ): FiscalCalculationInput => ({
      ...g4.input,
      tenantId,
      issueDate,
      lines: g4.input.lines.map((line) => ({
        ...line,
        classifications: { ...line.classifications, ...(classTrib ? { classTrib } : {}) },
      })),
    })
    // With the class, IBS/CBS join the legacy taxes; without it, the legacy side alone.
    const byDate = async () =>
      Object.fromEntries(
        await Promise.all(
          DATES.map(async (date) => [
            date,
            {
              withClassTrib: summary(await calculations.preview(inputOn(date))),
              legacyOnly: summary(await calculations.preview(inputOn(date, null))),
            },
          ]),
        ),
      )
    record.operation = `Phase 86's G4: a Lucro Real issuer's SP → SP resale of NCM 8509.40.10 to a contributor, 2 × 189,90, with cClassTrib ${CLASS_TRIB}`
    record.beforeNextVersion = await byDate()

    const lock = async (date: string) => {
      const documentId = randomUUID()
      const intentId = randomUUID()
      await admin`insert into fiscal_intents (
        id, tenant_id, origin_module, origin_document_type, origin_id, purpose, order_id,
        customer_id, payload_digest
      ) values (
        ${intentId}, ${tenantId}, 'sales', 'shipment', ${randomUUID()}, 'original',
        ${randomUUID()}, ${randomUUID()}, ${'d'.repeat(64)}
      )`
      await admin`insert into fiscal_documents (
        id, tenant_id, intent_id, model, environment, establishment_id, series,
        snapshot_digest, snapshot_ciphertext
      ) values (
        ${documentId}, ${tenantId}, ${intentId}, '55', 'simulation',
        ${g4.input.issuerEstablishmentId}, 1, ${'d'.repeat(64)}, ${Buffer.from('isolated')}
      )`
      const outcome = await calculations.validateDocument({
        tenantId,
        documentId,
        actorId: 'phase89:issuer',
        calculationInput: inputOn(date),
      })
      return { documentId, date, outcome: summary(outcome) }
    }
    const locked2026 = await lock('2026-12-30')
    const refused2027 = await lock('2027-03-15')

    // The next version: the hypothetical 2027 package, with its impact on what is locked.
    adoptions.push(await adopt('rtc-v0059-hypothetical-2027'))
    record.adoptions = adoptions
    record.afterNextVersion = await byDate()
    const locked2027 = await lock('2027-03-15')
    const replayed = await calculations.replay(tenantId, locked2026.documentId)
    record.locks = {
      locked2026,
      lockIn2027BeforeTheNextVersion: refused2027,
      lockIn2027AfterIt: locked2027,
      replay2026AfterTheNextVersion: {
        reproduced:
          replayed.resultDigest === (locked2026.outcome as { resultDigest?: string }).resultDigest,
        resultDigest: replayed.resultDigest,
      },
    }
    const out = env('OUT')
    await writeFile(out, `${JSON.stringify(record, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify({ written: out })}\n`)
  } finally {
    await Promise.allSettled([
      changes.close(),
      calculations.close(),
      store.close(),
      publisher.close(),
      admin.end(),
    ])
  }
}

function labelOf(packs: readonly { label: string }[], index: number): string {
  const found = packs[index]
  if (!found) throw new Error('Phase 86 declares three packages')
  return found.label
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  )
  process.exit(1)
})
