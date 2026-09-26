import postgres from 'postgres'
import { z } from 'zod'
import { FiscalCapabilities } from './capabilities'
import { FiscalNfseRegistry } from './nfse/registry'
import { NFSE_SCHEMA_DIGEST } from './nfse/schema'
import { NFSE_OPERATION } from './nfse/service-origins'
import {
  approvedPhase47IbsCbsSource,
  approvedPhase47IssSource,
  PHASE47_ADAPTER,
  PHASE47_FIXTURE,
  PHASE47_MUNICIPAL_PARAMETERS,
  PHASE47_SOURCE_MANIFEST_DIGEST,
  phase47RegistryVersion,
} from './phase47-approved-scenario'
import { FiscalProjections } from './projections'
import { FiscalRuleStore } from './rule-store'

/** The owner's provisional simulation reading of the NFS-e facts (see the Phase 47 plan). */
const SERVICE_PROFILE = {
  substitutionWindowDays: 30,
  operationIndicator: '100301',
  ibsCbs: { cst: '000', classification: '000001' },
} as const

function flag(name: string, required = true): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  const value = index < 0 ? undefined : process.argv[index + 1]
  if (required && !value) throw new Error(`--${name} is required`)
  return value
}

/**
 * Prepares the Phase 47 national NFS-e tuple of one establishment: the reviewed municipal
 * registry version, the ISS and IBS/CBS rules of its municipality and one capability
 * row keyed by that municipality. A municipality the registry does not route to the
 * national system is refused. The row is activated only when an evidence digest is
 * given. It prints the `service` block the issuance profile needs.
 */
async function main(): Promise<void> {
  const databaseUrl = z.url().parse(process.env.DATABASE_URL)
  const masterKey = Buffer.from(
    z
      .string()
      .regex(/^[0-9a-f]{64}$/i)
      .parse(process.env.FISCAL_ARTIFACT_KEY_HEX),
    'hex',
  )
  const tenantId = z.uuid().parse(flag('tenant'))
  const establishmentId = z.uuid().parse(flag('establishment'))
  const evidenceDigest = z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional()
    .parse(flag('evidence-digest', false))
  const store = new FiscalRuleStore(databaseUrl, 120_000)
  const capabilities = new FiscalCapabilities(databaseUrl)
  const registry = new FiscalNfseRegistry(databaseUrl)
  const projections = new FiscalProjections(databaseUrl, masterKey)
  const sql = postgres(databaseUrl, { max: 2, connection: { statement_timeout: 10_000 } })
  try {
    const today = new Date().toISOString().slice(0, 10)
    const issuer = await projections.resolveIssuer(tenantId, today)
    const municipalityCode = issuer?.company.address.municipalityCode
    if (!municipalityCode) throw new Error('The issuer has no projected IBGE municipality')
    const version = await registry.importVersion({
      tenantId,
      actorId: 'agent:claude',
      request: phase47RegistryVersion(),
    })
    const reviewed = await registry.review({
      tenantId,
      versionId: version.id,
      actorId: 'workspace-owner',
      interpretation:
        'Workspace owner provisionally approved, for simulation only, the São Paulo and Campinas rows of the official adhering-municipalities list of 2026-09-18.',
    })
    const resolution = await registry.resolve(tenantId, municipalityCode, today)
    if (resolution.route !== 'national')
      throw new Error(`Municipality ${municipalityCode} is unsupported: ${resolution.reason}`)
    const parameters = PHASE47_MUNICIPAL_PARAMETERS.find(
      (entry) => entry.municipalityCode === municipalityCode,
    )
    if (!parameters) throw new Error('No reviewed municipal parameters for this municipality')
    const ruleIds: string[] = []
    for (const source of [
      approvedPhase47IbsCbsSource(tenantId, municipalityCode),
      approvedPhase47IssSource(tenantId, municipalityCode),
    ]) {
      const imported = await store.importSource(source)
      const [approval] = await sql.begin(async (tx) => {
        await tx`select set_config('app.current_tenant', ${tenantId}, true)`
        return tx`select id from fiscal_package_reviews where tenant_id = ${tenantId}
          and package_id = ${imported.packageId} and approved = true limit 1`
      })
      if (!approval)
        await store.reviewPackage({
          tenantId,
          packageId: imported.packageId,
          approved: true,
          reviewedBy: 'workspace-owner',
          reviewedAt: new Date().toISOString(),
          interpretation:
            'Workspace owner provisionally approved, for simulation only, the national NFS-e service provision at the RTC V0057 reference rates and the provisional municipal ISS reading. Comprehensive Fiscal review is deferred until the Fiscal program is complete.',
          fixtureIds: [PHASE47_FIXTURE],
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
            reason: 'Workspace-owner approved Phase 47 local simulation rollout',
          })
        ruleIds.push(ruleId)
      }
    }
    const definition = await capabilities.register({
      tenantId,
      model: 'nfse',
      environment: 'simulation',
      establishmentId,
      jurisdictionKind: 'municipality',
      jurisdictionCode: municipalityCode,
      operation: NFSE_OPERATION,
      adapterVersion: PHASE47_ADAPTER,
      sourceManifestDigest: PHASE47_SOURCE_MANIFEST_DIGEST,
      schemaPackageDigest: NFSE_SCHEMA_DIGEST,
      calculationFixtureId: PHASE47_FIXTURE,
      createdBy: 'agent:claude',
    })
    await capabilities.review({
      tenantId,
      capabilityId: definition.id,
      approved: true,
      reviewedBy: 'workspace-owner',
      reviewedAt: new Date().toISOString(),
      interpretation:
        'Workspace owner provisionally approved the national NFS-e simulation tuple (layout 1.01, municipality from the reviewed registry, provisional 2% ISS, 30-day cancellation and substitution windows). Comprehensive Fiscal review is deferred.',
    })
    if (evidenceDigest)
      await capabilities.change({
        tenantId,
        capabilityId: definition.id,
        action: 'activate_simulated',
        evidenceDigest,
        actorId: 'workspace-owner',
        reason: 'Activate the reviewed Phase 47 national NFS-e simulation tuple',
        occurredAt: new Date().toISOString(),
      })
    process.stdout.write(
      `${JSON.stringify(
        {
          tenantId,
          establishmentId,
          municipalityCode,
          registryVersionId: reviewed.id,
          phase47RuleIds: ruleIds,
          active: Boolean(evidenceDigest),
          profileService: {
            capabilityId: definition.id,
            municipalityCode,
            cancellationWindowDays: parameters.cancellationWindowDays,
            ...SERVICE_PROFILE,
          },
        },
        null,
        2,
      )}\n`,
    )
  } finally {
    await Promise.all([
      store.close(),
      capabilities.close(),
      registry.close(),
      projections.close(),
      sql.end(),
    ])
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Phase 47 rollout failed')
  process.exitCode = 1
})
