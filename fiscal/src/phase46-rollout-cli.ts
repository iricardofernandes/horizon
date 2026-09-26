import postgres from 'postgres'
import { z } from 'zod'
import { FiscalCapabilities } from './capabilities'
import { PHASE46_FIXTURE } from './document-kinds'
import { approvedPhase46Source } from './phase46-approved-scenario'
import { FiscalRuleStore } from './rule-store'

/** The owner's provisional simulation reading of the NFC-e facts (see the Phase 46 plan). */
const CONSUMER_PROFILE = {
  natureOperation: 'Venda a consumidor final',
  presence: '4',
  payment: { indicator: '1', method: '05' },
  cancellationWindowMinutes: 30,
} as const

function flag(name: string, required = true): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  const value = index < 0 ? undefined : process.argv[index + 1]
  if (required && !value) throw new Error(`--${name} is required`)
  return value
}

/**
 * Prepares the Phase 46 NFC-e model 65 tuple next to an establishment's active model 55
 * simulation capability: the reviewed consumer-sale rules and one model 65 capability row.
 * The row is activated only when an evidence digest is given. It prints the `consumer`
 * block the issuance profile needs.
 */
async function main(): Promise<void> {
  const databaseUrl = z.url().parse(process.env.DATABASE_URL)
  const tenantId = z.uuid().parse(flag('tenant'))
  const establishmentId = z.uuid().parse(flag('establishment'))
  const evidenceDigest = z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional()
    .parse(flag('evidence-digest', false))
  const store = new FiscalRuleStore(databaseUrl, 120_000)
  const capabilities = new FiscalCapabilities(databaseUrl)
  const sql = postgres(databaseUrl, { max: 2, connection: { statement_timeout: 10_000 } })
  try {
    const sale = (await capabilities.listActive(tenantId)).find(
      (row) =>
        row.establishmentId === establishmentId &&
        row.environment === 'simulation' &&
        row.model === '55' &&
        row.operation === 'normal-sale',
    )
    if (!sale) throw new Error('The establishment has no active normal-sale simulation capability')
    const imported = await store.importSource(approvedPhase46Source(tenantId))
    const [reviewed] = await sql.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select id from fiscal_package_reviews where tenant_id = ${tenantId}
        and package_id = ${imported.packageId} and approved = true limit 1`
    })
    const reviewedAt = new Date().toISOString()
    if (!reviewed)
      await store.reviewPackage({
        tenantId,
        packageId: imported.packageId,
        approved: true,
        reviewedBy: 'workspace-owner',
        reviewedAt,
        interpretation:
          'Workspace owner provisionally approved, for simulation only, the NFC-e model 65 consumer sale at the RTC V0057 reference rates of the model 55 sale. Comprehensive Fiscal review is deferred until the Fiscal program is complete.',
        fixtureIds: [PHASE46_FIXTURE],
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
          reason: 'Workspace-owner approved Phase 46 local simulation rollout',
        })
    }
    const definition = await capabilities.register({
      tenantId,
      model: '65',
      environment: 'simulation',
      establishmentId,
      jurisdictionKind: 'uf',
      jurisdictionCode: sale.jurisdictionCode,
      operation: 'consumer-sale',
      adapterVersion: 'nfce65-simulator-v1',
      sourceManifestDigest: sale.sourceManifestDigest,
      schemaPackageDigest: sale.schemaPackageDigest,
      calculationFixtureId: PHASE46_FIXTURE,
      createdBy: 'agent:claude',
    })
    await capabilities.review({
      tenantId,
      capabilityId: definition.id,
      approved: true,
      reviewedBy: 'workspace-owner',
      reviewedAt,
      interpretation:
        'Workspace owner provisionally approved the NFC-e model 65 consumer-sale simulation tuple (PL 010f, QR code v3 online per NT 2025.001, DANFE NFC-e manual v6.0, presence 4, payment 05 on account, 30-minute cancellation window). Comprehensive Fiscal review is deferred.',
    })
    if (evidenceDigest)
      await capabilities.change({
        tenantId,
        capabilityId: definition.id,
        action: 'activate_simulated',
        evidenceDigest,
        actorId: 'workspace-owner',
        reason: 'Activate the reviewed Phase 46 NFC-e consumer-sale simulation tuple',
        occurredAt: new Date().toISOString(),
      })
    process.stdout.write(
      `${JSON.stringify(
        {
          tenantId,
          establishmentId,
          saleCapabilityId: sale.id,
          phase46PackageId: imported.packageId,
          phase46RuleIds: imported.ruleIds,
          active: Boolean(evidenceDigest),
          profileConsumer: { capabilityId: definition.id, ...CONSUMER_PROFILE },
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
  console.error(error instanceof Error ? error.message : 'Phase 46 rollout failed')
  process.exitCode = 1
})
