#!/usr/bin/env node

import 'dotenv/config'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import postgres from 'postgres'

const url = process.env.DATABASE_MIGRATION_URL
if (!url) throw new Error('DATABASE_MIGRATION_URL is required')
const folder = new URL('../src/infrastructure/database/migrations', import.meta.url).pathname
const client = postgres(url, { max: 1, connect_timeout: 5 })

try {
  await client`create schema if not exists horizon_migrations`
  await client`create table if not exists horizon_migrations.applied (
    name text primary key, applied_at timestamptz not null default now()
  )`
  for (const name of (await readdir(folder)).filter((file) => file.endsWith('.sql')).sort()) {
    const [applied] = await client`select 1 from horizon_migrations.applied where name = ${name}`
    if (applied) continue
    const sql = await readFile(join(folder, name), 'utf8')
    await client.begin(async (transaction) => {
      await transaction.unsafe(sql)
      await transaction`insert into horizon_migrations.applied (name) values (${name})`
    })
  }
} finally {
  await client.end({ timeout: 5 })
}
