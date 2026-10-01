import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import postgres from 'postgres'
import { FiscalCalculations } from './calculations'
import { canonicalJson } from './canonical-json'
import { FiscalCatalog } from './catalog'
import {
  approvedPhase41Publication,
  PHASE41_CATALOG_IDENTITY,
  PHASE41_FIXTURE_ID,
  PHASE41_SOURCE_SHA256,
} from './phase41-approved-scenario'
import { changeSummary, withRuleChanges } from './rule-change-cli'
import { FiscalRuleStore } from './rule-store'

/**
 * Phase 82 rollout (ADR 0070):
 *   publish-phase41 --artifact <calculadora.zip>    as the migration role (DATABASE_MIGRATION_URL)
 *   retire-copy --tenant <id>                        the workspace's own copy of the same package
 *   adopt --tenant <id> --effective-from <date> --reviewed-by <who> --actor <who>
 *   verify --fixture <file>                          the approved result, from the catalogue
 *   verify-lock --tenant <id> --document <id>        a locked calculation, replayed
 */

const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? undefined : process.argv[index + 1]
}
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

async function publishPhase41(): Promise<unknown> {
  const bytes = await readFile(required('artifact'))
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== PHASE41_SOURCE_SHA256)
    throw new Error(`Phase 41 source digest mismatch: ${digest}`)
  const catalog = new FiscalCatalog(env('DATABASE_MIGRATION_URL'), 120_000)
  try {
    return await catalog.publish(
      approvedPhase41Publication({ byteSize: bytes.length }),
      PHASE41_CATALOG_IDENTITY,
    )
  } finally {
    await catalog.close()
  }
}

/** Deactivates the workspace's active rules that come from a source with the catalogue's digest. */
async function retireCopy(): Promise<unknown> {
  const tenantId = required('tenant')
  const sql = postgres(env('DATABASE_URL'), { max: 1 })
  const store = new FiscalRuleStore(env('DATABASE_URL'))
  try {
    const rules = await sql.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx<{ id: string }[]>`select rule.id from fiscal_tax_rules rule
        join fiscal_source_packages package on package.tenant_id = rule.tenant_id
          and package.id = rule.package_id
        join fiscal_catalog_packages catalogue on catalogue.package_digest = package.package_digest
          and catalogue.authority = package.authority
        join lateral (
          select event.action from fiscal_rule_activation_events event
          where event.tenant_id = rule.tenant_id and event.rule_id = rule.id
          order by event.sequence desc limit 1
        ) latest on latest.action = 'activate'
        where rule.tenant_id = ${tenantId}`
    })
    for (const rule of rules)
      await store.activateRule({
        tenantId,
        ruleId: rule.id,
        action: 'deactivate',
        actorId: required('actor'),
        reason: 'Retired in favour of the shared catalogue (Phase 82, ADR 0070)',
      })
    return { retired: rules.map((rule) => rule.id) }
  } finally {
    await Promise.all([store.close(), sql.end()])
  }
}

/** Asks for the adoption; another person approves it with `approve` (Phase 88, ADR 0074). */
async function requestAdoption(): Promise<unknown> {
  return withRuleChanges(env('DATABASE_URL'), env('FISCAL_ARTIFACT_KEY_HEX'), async (changes) =>
    changeSummary(
      await changes.request({
        tenantId: required('tenant'),
        actorId: required('requested-by'),
        body: {
          kind: 'adopt-package',
          packageId: option('package') ?? PHASE41_CATALOG_IDENTITY.packageId,
          effectiveFrom: required('effective-from'),
          interpretation:
            option('interpretation') ??
            'The Phase 41 approved RTC V0057 scenario, adopted from the shared catalogue.',
          fixtureIds: [option('fixture-id') ?? PHASE41_FIXTURE_ID],
          reason: option('reason') ?? 'Phase 82: tax law read from the shared catalogue',
        },
      }),
    ),
  )
}

/** Approves a pending rule change someone else requested. */
async function approve(): Promise<unknown> {
  return withRuleChanges(env('DATABASE_URL'), env('FISCAL_ARTIFACT_KEY_HEX'), async (changes) =>
    changeSummary(
      await changes.decide({
        tenantId: required('tenant'),
        actorId: required('approved-by'),
        holdsApproval: true,
        changeId: required('change'),
        outcome: 'approved',
        reason: option('reason'),
      }),
    ),
  )
}

async function verify(): Promise<unknown> {
  const fixture = JSON.parse(await readFile(required('fixture'), 'utf8'))
  const store = new FiscalRuleStore(env('DATABASE_URL'))
  const calculations = new FiscalCalculations(
    env('DATABASE_URL'),
    Buffer.from(env('FISCAL_ARTIFACT_KEY_HEX'), 'hex'),
    store,
  )
  try {
    const result = await calculations.preview(fixture.input)
    const matches =
      canonicalJson(result).toString() === canonicalJson(fixture.expectedResult).toString()
    if (!matches) throw new Error('The catalogue does not reproduce the approved result')
    return {
      matches,
      ...(result.supported
        ? {
            inputDigest: result.inputDigest,
            rulesDigest: result.rulesDigest,
            resultDigest: result.resultDigest,
          }
        : {}),
    }
  } finally {
    await Promise.all([calculations.close(), store.close()])
  }
}

/** A locked calculation replays from what it stored, whatever the catalogue now says. */
async function verifyLock(): Promise<unknown> {
  const store = new FiscalRuleStore(env('DATABASE_URL'))
  const calculations = new FiscalCalculations(
    env('DATABASE_URL'),
    Buffer.from(env('FISCAL_ARTIFACT_KEY_HEX'), 'hex'),
    store,
  )
  try {
    const replayed = await calculations.replay(required('tenant'), required('document'))
    return {
      replayed: true,
      inputDigest: replayed.inputDigest,
      rulesDigest: replayed.rulesDigest,
      resultDigest: replayed.resultDigest,
    }
  } finally {
    await Promise.all([calculations.close(), store.close()])
  }
}

const actions: Record<string, () => Promise<unknown>> = {
  'publish-phase41': publishPhase41,
  'retire-copy': retireCopy,
  'request-adoption': requestAdoption,
  approve,
  verify,
  'verify-lock': verifyLock,
}

const action = process.argv[2] ?? ''
const run = actions[action]
if (!run) {
  console.error(`usage: phase82-catalog-cli <${Object.keys(actions).join('|')}> [options]`)
  process.exit(2)
}
run()
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
