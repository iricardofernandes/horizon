import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import postgres from 'postgres'
import { z } from 'zod'
import { FiscalCapabilities } from './capabilities'
import {
  approvedPhase41Source,
  PHASE41_FIXTURE_ID,
  PHASE41_SOURCE_SHA256,
} from './phase41-approved-scenario'
import { FiscalRuleStore } from './rule-store'

function flag(name: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index < 0 ? undefined : process.argv[index + 1]
  if (!value) throw new Error(`--${name} is required`)
  return value
}

async function fileDigest(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function main(): Promise<void> {
  const databaseUrl = z.url().parse(process.env.DATABASE_URL)
  const tenantId = z.uuid().parse(flag('tenant'))
  const establishmentId = z.uuid().parse(flag('establishment'))
  const artifactPath = resolve(flag('source-artifact'))
  const manifestPath = resolve(flag('manifest'))
  const [sourceDigest, sourceStat, manifestBytes] = await Promise.all([
    fileDigest(artifactPath),
    stat(artifactPath),
    readFile(manifestPath),
  ])
  if (sourceDigest !== PHASE41_SOURCE_SHA256)
    throw new Error('The pinned Phase 41 source artifact digest does not match')
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  const review = manifest.selection?.review
  if (
    manifest.selection?.fiscalReviewStatus !== 'workspace-owner-provisionally-approved' ||
    review?.decision !== 'provisional-approval' ||
    review.reviewedBy !== 'workspace-owner' ||
    review.comprehensiveReviewDeferred !== true
  )
    throw new Error('The workspace-owner simulation approval is missing from the manifest')
  const reviewedAt = z.iso.datetime({ offset: true }).parse(review.reviewedAt)
  const documentPackage = manifest.artifacts?.find(
    (item: { id: string }) => item.id === 'nfe-pl-010f-v1.04',
  )
  const eventPackage = manifest.artifacts?.find(
    (item: { id: string }) => item.id === 'nfe-pl-010d-v1.03-event-candidate',
  )
  const schemaPackageDigest = z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .parse(documentPackage?.sha256)
  const eventPackageDigest = z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .parse(eventPackage?.sha256)
  if (
    eventPackage?.selectionStatus !==
    'selected-for-model55-simulation-with-application-detail-checks'
  )
    throw new Error('The cancellation event package is not selected for simulation')
  const sourceManifestDigest = createHash('sha256').update(manifestBytes).digest('hex')
  const store = new FiscalRuleStore(databaseUrl, 120_000)
  const capabilities = new FiscalCapabilities(databaseUrl)
  const sql = postgres(databaseUrl, { max: 2, connection: { statement_timeout: 10_000 } })
  try {
    const imported = await store.importSource(
      approvedPhase41Source(tenantId, {
        byteSize: sourceStat.size,
        storageUri: pathToFileURL(artifactPath).href,
      }),
    )
    const [packageReview] = await sql.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select id from fiscal_package_reviews where tenant_id = ${tenantId}
        and package_id = ${imported.packageId} and approved = true
        and reviewed_by = 'workspace-owner' limit 1`
    })
    if (!packageReview)
      await store.reviewPackage({
        tenantId,
        packageId: imported.packageId,
        approved: true,
        reviewedBy: 'workspace-owner',
        reviewedAt,
        interpretation:
          'Workspace owner approved the pinned RTC V0057 normal-sale SP simulation fixture for Phase 42. Comprehensive Fiscal review is deferred until the Fiscal program is complete.',
        fixtureIds: [PHASE41_FIXTURE_ID],
      })
    for (const ruleId of imported.ruleIds) {
      const [latest] = await sql.begin(async (tx) => {
        await tx`select set_config('app.current_tenant', ${tenantId}, true)`
        return tx`select action from fiscal_rule_activation_events where tenant_id = ${tenantId}
          and rule_id = ${ruleId} order by created_at desc, id desc limit 1`
      })
      if (latest?.action !== 'activate')
        await store.activateRule({
          tenantId,
          ruleId,
          action: 'activate',
          actorId: 'workspace-owner',
          reason: 'Workspace-owner approved Phase 42 local simulation rollout',
        })
    }
    const definition = await capabilities.register({
      tenantId,
      model: '55',
      environment: 'simulation',
      establishmentId,
      jurisdictionKind: 'uf',
      jurisdictionCode: 'SP',
      operation: 'normal-sale',
      adapterVersion: 'nfe55-simulator-v1',
      sourceManifestDigest,
      schemaPackageDigest,
      calculationFixtureId: PHASE41_FIXTURE_ID,
      createdBy: 'agent:codex',
    })
    const capabilityReview = await capabilities.review({
      tenantId,
      capabilityId: definition.id,
      approved: true,
      reviewedBy: 'workspace-owner',
      reviewedAt,
      interpretation: `Workspace owner provisionally approved PL 010f ${schemaPackageDigest} for model-55 simulation and PL 010d ${eventPackageDigest} as a generic cancellation envelope with application-level detEvento checks. Comprehensive Fiscal review is deferred until the Fiscal program is complete.`,
    })
    process.stdout.write(
      `${JSON.stringify(
        {
          tenantId,
          establishmentId,
          capabilityId: definition.id,
          capabilityReviewId: capabilityReview.id,
          sourceManifestDigest,
          schemaPackageDigest,
          eventPackageDigest,
          phase41PackageId: imported.packageId,
          phase41RuleIds: imported.ruleIds,
          active: false,
        },
        null,
        2,
      )}\n`,
    )
  } finally {
    await Promise.all([store.close(), capabilities.close(), sql.end()])
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Phase 42 rollout preparation failed')
  process.exitCode = 1
})
