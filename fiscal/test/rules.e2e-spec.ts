import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import postgres from 'postgres'
import { afterAll, beforeAll, expect, it } from 'vitest'

let container: StartedPostgreSqlContainer
let administrator: ReturnType<typeof postgres>
let app: ReturnType<typeof postgres>
let appUrl: string

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('horizon_fiscal_rules_test')
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
  appUrl = container.getConnectionUri().replace('postgres:test@', 'horizon_app:test@')
  await promisify(execFile)(process.execPath, ['scripts/migrate.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_MIGRATION_URL: migrationUrl },
  })
  app = postgres(appUrl, { max: 2 })
}, 120_000)

afterAll(async () => {
  await Promise.allSettled([app?.end(), administrator?.end(), container?.stop()])
})

it('requires package approval before activation and keeps activation history immutable', async () => {
  const tenantId = randomUUID()
  const packageId = randomUUID()
  const ruleId = randomUUID()
  await administrator`insert into tenants (id) values (${tenantId})`
  await app.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${tenantId}, true)`
    await insertPackage(tx, tenantId, packageId, 'a'.repeat(64))
    await insertRule(tx, tenantId, packageId, ruleId, 1, '2026-01-01', '2027-01-01')
  })

  await expect(
    app.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      await activate(tx, tenantId, ruleId, 'activate', 'not reviewed yet')
    }),
  ).rejects.toMatchObject({ code: '23514' })

  await app.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${tenantId}, true)`
    await tx`insert into fiscal_package_reviews (
      id, tenant_id, package_id, approved, reviewed_by, reviewed_at, interpretation, fixture_ids
    ) values (
      ${randomUUID()}, ${tenantId}, ${packageId}, true, 'specialist:test', now(),
      'Illustrative fixture only', ${['fixture-1']}
    )`
    await activate(tx, tenantId, ruleId, 'activate', 'approved fixture')
  })

  await expect(
    app.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      await activate(tx, tenantId, ruleId, 'activate', 'duplicate activation')
    }),
  ).rejects.toMatchObject({ code: '23505' })

  await app.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${tenantId}, true)`
    await activate(tx, tenantId, ruleId, 'deactivate', 'rollback fixture')
  })
  await expect(
    administrator`update fiscal_rule_activation_events set reason = 'rewritten' where rule_id = ${ruleId}`,
  ).rejects.toThrow('append-only')
})

it('rejects equal-scope overlaps, permits adjacent windows and isolates tenants', async () => {
  const tenantId = randomUUID()
  const otherTenantId = randomUUID()
  const packageId = randomUUID()
  await administrator`insert into tenants (id) values (${tenantId}), (${otherTenantId})`
  await app.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${tenantId}, true)`
    await insertPackage(tx, tenantId, packageId, 'b'.repeat(64))
    await insertRule(tx, tenantId, packageId, randomUUID(), 1, '2026-01-01', '2026-07-01')
    await insertRule(tx, tenantId, packageId, randomUUID(), 2, '2026-07-01', '2027-01-01')
  })
  await expect(
    app.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      await insertRule(tx, tenantId, packageId, randomUUID(), 3, '2026-06-01', '2026-08-01')
    }),
  ).rejects.toMatchObject({ code: '23P01' })

  const visible = await app.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${otherTenantId}, true)`
    return tx`select id from fiscal_tax_rules where tenant_id = ${tenantId}`
  })
  expect(visible).toEqual([])
})

async function insertPackage(
  sql: postgres.TransactionSql,
  tenantId: string,
  packageId: string,
  digest: string,
) {
  await sql`insert into fiscal_source_packages (
    id, tenant_id, authority, source_uri, package_digest, published_at, effective_from
  ) values (
    ${packageId}, ${tenantId}, 'fixture', 'https://example.invalid/fixture', ${digest},
    '2026-01-01', '2026-01-01'
  )`
}

async function insertRule(
  sql: postgres.TransactionSql,
  tenantId: string,
  packageId: string,
  ruleId: string,
  version: number,
  effectiveFrom: string,
  effectiveTo: string,
) {
  await sql`insert into fiscal_tax_rules (
    id, tenant_id, package_id, rule_key, version, component_group, component_code,
    precedence, priority, model, environment, effective_from, effective_to,
    rate_numerator, rate_denominator, formula, source_locator, definition_digest
  ) values (
    ${ruleId}, ${tenantId}, ${packageId}, 'illustrative.tax', ${version}, 'legacy',
    'ILLUSTRATIVE_TAX', 'default', 0, '55', 'simulation', ${effectiveFrom},
    ${effectiveTo}, '1', '10', 'LINE_NET_TIMES_RATE', 'fixture-only', ${'c'.repeat(64)}
  )`
}

async function activate(
  sql: postgres.TransactionSql,
  tenantId: string,
  ruleId: string,
  action: 'activate' | 'deactivate',
  reason: string,
) {
  await sql`insert into fiscal_rule_activation_events (
    id, tenant_id, rule_id, action, actor_id, reason
  ) values (${randomUUID()}, ${tenantId}, ${ruleId}, ${action}, 'admin:test', ${reason})`
}
