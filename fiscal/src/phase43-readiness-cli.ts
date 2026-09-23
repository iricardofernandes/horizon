import { z } from 'zod'
import { FiscalCalculations } from './calculations'
import { FiscalCapabilities } from './capabilities'
import { FiscalDocuments } from './documents'
import { FiscalProjections } from './projections'
import { FiscalReadiness } from './readiness'
import { FiscalRuleStore } from './rule-store'

function flag(name: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index < 0 ? undefined : process.argv[index + 1]
  if (!value) throw new Error(`--${name} is required`)
  return value
}

async function main(): Promise<void> {
  const databaseUrl = z.url().parse(process.env.DATABASE_URL)
  const key = z
    .string()
    .regex(/^[0-9a-f]{64}$/i)
    .parse(process.env.FISCAL_ARTIFACT_KEY_HEX)
  const tenantId = z.uuid().parse(flag('tenant'))
  const documentId = z.uuid().parse(flag('document'))
  const drillGrantId = z.uuid().parse(flag('grant'))
  const actorId = z.string().min(1).max(200).parse(flag('actor'))
  const secret = Buffer.from(key, 'hex')
  const documents = new FiscalDocuments(databaseUrl, secret)
  const projections = new FiscalProjections(databaseUrl)
  const capabilities = new FiscalCapabilities(databaseUrl)
  const rules = new FiscalRuleStore(databaseUrl)
  const calculations = new FiscalCalculations(databaseUrl, secret, rules)
  try {
    const readiness = new FiscalReadiness(documents, projections, capabilities, calculations)
    const result = await readiness.validateHomologationDrill({
      tenantId,
      documentId,
      drillGrantId,
      actorId,
    })
    process.stdout.write(
      `${JSON.stringify(
        result.supported
          ? {
              supported: true,
              documentId,
              capabilityId: result.capabilityId,
              inputDigest: result.inputDigest,
              rulesDigest: result.rulesDigest,
              resultDigest: result.resultDigest,
              reconciliationDigest: result.reconciliationDigest,
            }
          : {
              supported: false,
              documentId,
              code: result.code,
              detail: result.detail,
              inputDigest: result.inputDigest ?? null,
            },
        null,
        2,
      )}\n`,
    )
    if (!result.supported) process.exitCode = 2
  } finally {
    await Promise.all([
      documents.close(),
      projections.close(),
      capabilities.close(),
      rules.close(),
      calculations.close(),
    ])
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Phase 43 readiness command failed')
  process.exitCode = 1
})
