import postgres from 'postgres'
import { z } from 'zod'
import { FiscalCapabilities } from './capabilities'
import { PHASE45_FIXTURES } from './document-kinds'
import { approvedPhase45Source } from './phase45-approved-scenario'
import { FiscalRuleStore } from './rule-store'

const LINKED = {
  'sale-return': { cfop: '1202', natureOperation: 'Devolução de venda de mercadoria' },
  'purchase-return': { cfop: '5202', natureOperation: 'Devolução de compra para comercialização' },
  'value-complement': { cfop: '5102', natureOperation: 'Complemento de valor' },
} as const

function flag(name: string, required = true): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  const value = index < 0 ? undefined : process.argv[index + 1]
  if (required && !value) throw new Error(`--${name} is required`)
  return value
}

/**
 * Prepares the Phase 45 linked-document tuples next to an establishment's active
 * normal-sale simulation capability: the reviewed return and complement rules, and one
 * capability row per kind. Rows are activated only when an evidence digest is given.
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
        row.operation === 'normal-sale',
    )
    if (!sale) throw new Error('The establishment has no active normal-sale simulation capability')
    const imported = await store.importSource(approvedPhase45Source(tenantId))
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
          'Workspace owner provisionally approved, for simulation only, returns and value complements at the RTC V0057 reference rates of the original sale. Comprehensive Fiscal review is deferred until the Fiscal program is complete.',
        fixtureIds: Object.values(PHASE45_FIXTURES),
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
          reason: 'Workspace-owner approved Phase 45 local simulation rollout',
        })
    }
    const linked: Record<string, { capabilityId: string; cfop: string; natureOperation: string }> =
      {}
    for (const kind of Object.keys(LINKED) as Array<keyof typeof LINKED>) {
      const definition = await capabilities.register({
        tenantId,
        model: '55',
        environment: 'simulation',
        establishmentId,
        jurisdictionKind: 'uf',
        jurisdictionCode: sale.jurisdictionCode,
        operation: kind,
        adapterVersion: sale.adapterVersion,
        sourceManifestDigest: sale.sourceManifestDigest,
        schemaPackageDigest: sale.schemaPackageDigest,
        calculationFixtureId: PHASE45_FIXTURES[kind],
        createdBy: 'agent:claude',
      })
      await capabilities.review({
        tenantId,
        capabilityId: definition.id,
        approved: true,
        reviewedBy: 'workspace-owner',
        reviewedAt,
        interpretation: `Workspace owner provisionally approved the ${kind} NF-e model 55 simulation tuple (finNFe, NFref and the CFOP ${LINKED[kind].cfop} profile) under PL 010f. Comprehensive Fiscal review is deferred.`,
      })
      if (evidenceDigest)
        await capabilities.change({
          tenantId,
          capabilityId: definition.id,
          action: 'activate_simulated',
          evidenceDigest,
          actorId: 'workspace-owner',
          reason: `Activate the reviewed Phase 45 ${kind} simulation tuple`,
          occurredAt: new Date().toISOString(),
        })
      linked[kind] = { capabilityId: definition.id, ...LINKED[kind] }
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          tenantId,
          establishmentId,
          saleCapabilityId: sale.id,
          phase45PackageId: imported.packageId,
          phase45RuleIds: imported.ruleIds,
          active: Boolean(evidenceDigest),
          profileLinked: linked,
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
  console.error(error instanceof Error ? error.message : 'Phase 45 rollout failed')
  process.exitCode = 1
})
