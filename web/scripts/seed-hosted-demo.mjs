import { randomBytes, scryptSync } from 'node:crypto'
import { neon } from '@neondatabase/serverless'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required')

const password = process.env.HORIZON_DEMO_PASSWORD ?? 'Horizon-demo-2026!'
const salt = randomBytes(16)
const passwordHash = scryptSync(password, salt, 32)
const sql = neon(databaseUrl)

await sql`
  create table if not exists horizon_demo_users (
    id uuid primary key,
    tenant_id uuid not null,
    tenant_slug text not null,
    tenant_name text not null default 'Horizon Demo',
    email text not null,
    name text not null,
    password_salt text not null,
    password_hash text not null,
    unique (tenant_slug, email)
  )
`
await sql`alter table horizon_demo_users add column if not exists tenant_name text not null default 'Horizon Demo'`
await sql`
  create table if not exists horizon_demo_catalog_items (
    id uuid primary key,
    tenant_id uuid not null,
    sku text not null,
    name text not null,
    kind text not null,
    active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (tenant_id, sku)
  )
`
await sql`
  create table if not exists horizon_demo_catalog_prices (
    tenant_id uuid not null,
    item_id uuid not null references horizon_demo_catalog_items(id),
    amount bigint not null check (amount >= 0),
    primary key (tenant_id, item_id)
  )
`

const tenantId = '00000000-0000-4000-8000-000000000001'
const userId = '00000000-0000-4000-8000-000000000002'
await sql`
  insert into horizon_demo_users
    (id, tenant_id, tenant_slug, tenant_name, email, name, password_salt, password_hash)
  values
    (${userId}, ${tenantId}, 'horizon-demo', 'Horizon Demo', 'demo@horizon.local', 'Demo Operator',
      ${salt.toString('hex')}, ${passwordHash.toString('hex')})
  on conflict (tenant_slug, email) do update set
    name = excluded.name,
    password_salt = excluded.password_salt,
    password_hash = excluded.password_hash
`

const items = [
  ['00000000-0000-4000-8000-000000000011', 'COFFEE-001', 'Roasted coffee', 'product', 1250],
  ['00000000-0000-4000-8000-000000000012', 'MUG-001', 'Stoneware mug', 'product', 3900],
  ['00000000-0000-4000-8000-000000000013', 'SHIP-001', 'Standard shipping', 'service', 1800],
]
for (const [id, sku, name, kind, amount] of items) {
  await sql`
    insert into horizon_demo_catalog_items (id, tenant_id, sku, name, kind)
    values (${id}, ${tenantId}, ${sku}, ${name}, ${kind})
    on conflict (tenant_id, sku) do update set name = excluded.name, kind = excluded.kind,
      active = true, updated_at = now()
  `
  await sql`
    insert into horizon_demo_catalog_prices (tenant_id, item_id, amount)
    values (${tenantId}, ${id}, ${amount})
    on conflict (tenant_id, item_id) do update set amount = excluded.amount
  `
}

process.stdout.write('Hosted demo schema and data are ready.\n')
