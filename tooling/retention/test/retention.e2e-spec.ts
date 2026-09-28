import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyRule } from '../src/retention.js'

let container: StartedPostgreSqlContainer
let owner: ReturnType<typeof postgres>
let relay: ReturnType<typeof postgres>

const TENANT_A = '01a0e900-0000-7000-8000-00000000000a'
const TENANT_B = '01a0e900-0000-7000-8000-00000000000b'

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start()
  owner = postgres(container.getConnectionUri(), { max: 1 })
  // The shape every module's inbox has, forced RLS, and the grant each retention migration adds.
  await owner.unsafe(`
    CREATE ROLE horizon_relay LOGIN PASSWORD 'test' NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE horizon_app LOGIN PASSWORD 'test' NOSUPERUSER NOBYPASSRLS;
    CREATE TABLE inbox (
      source_module text NOT NULL, event_id uuid NOT NULL, event_type text NOT NULL,
      tenant_id uuid NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (source_module, event_id)
    );
    ALTER TABLE inbox ENABLE ROW LEVEL SECURITY;
    ALTER TABLE inbox FORCE ROW LEVEL SECURITY;
    GRANT USAGE ON SCHEMA public TO horizon_relay;
    GRANT SELECT (tenant_id, received_at), DELETE ON inbox TO horizon_relay;
    CREATE POLICY relay_retention_read ON inbox FOR SELECT TO horizon_relay USING (true);
    CREATE POLICY relay_retention_delete ON inbox FOR DELETE TO horizon_relay USING (true);
  `)
  const url = new URL(container.getConnectionUri())
  url.username = 'horizon_relay'
  url.password = 'test'
  relay = postgres(url.toString(), { max: 1 })
}, 120_000)

afterAll(async () => {
  await Promise.allSettled([owner?.end(), relay?.end()])
  await container?.stop()
})

describe('applying a retention rule as the relay role', () => {
  it('removes only rows past their age, in batches, and counts them per tenant', async () => {
    await owner.unsafe(`
      INSERT INTO inbox (source_module, event_id, event_type, tenant_id, received_at)
      SELECT 'sales', gen_random_uuid(), 'sales.order.confirmed',
        CASE WHEN n % 3 = 0 THEN '${TENANT_B}'::uuid ELSE '${TENANT_A}'::uuid END,
        now() - (CASE WHEN n <= 250 THEN interval '120 days' ELSE interval '10 days' END)
      FROM generate_series(1, 300) AS n`)
    const counts = await applyRule(
      relay,
      {
        class: 'delivery-bookkeeping',
        database: 'sales',
        table: 'inbox',
        ageColumn: 'received_at',
        keepDays: 90,
      },
      new Date(),
      100,
    )
    const byTenant = Object.fromEntries(counts.map((count) => [count.tenant, count.removed]))
    expect(byTenant).toEqual({ [TENANT_A]: 167, [TENANT_B]: 83 })
    const [left] = await owner`select count(*)::int as total from inbox`
    expect(left?.total).toBe(50)
  })

  it('cannot read what a row says', async () => {
    await expect(relay`select event_type from inbox`).rejects.toThrow(/permission denied/)
  })
})
