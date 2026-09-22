import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const url = process.env.DATABASE_MIGRATION_URL
if (!url) throw new Error('DATABASE_MIGRATION_URL is required')
const client = postgres(url, { max: 1 })
const root = fileURLToPath(new URL('..', import.meta.url))
try {
  await client`create table if not exists fiscal_migrations
    (name text primary key, applied_at timestamptz not null default now())`
  for (const name of [
    '0001_phase39_ingress.sql',
    '0002_phase40_documents.sql',
    '0003_phase40_artifacts.sql',
    '0004_phase40_audit.sql',
    '0005_phase40_snapshots.sql',
    '0006_phase40_lifecycle.sql',
    '0007_phase40_reference_and_imports.sql',
    '0008_phase40_cancellation.sql',
    '0009_phase40_origin_payloads.sql',
    '0010_phase41_temporal_rules.sql',
  ]) {
    const [existing] = await client`select name from fiscal_migrations where name = ${name}`
    if (existing) continue
    const source = readFileSync(join(root, 'migrations', name), 'utf8')
    await client.begin(async (tx) => {
      await tx.unsafe(source, [], { prepare: false })
      await tx`insert into fiscal_migrations (name) values (${name})`
    })
  }
} finally {
  await client.end()
}
