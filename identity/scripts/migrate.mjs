import 'dotenv/config'

import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

const url = process.env.DATABASE_MIGRATION_URL
if (!url) throw new Error('DATABASE_MIGRATION_URL is required')

const client = postgres(url, {
  max: 1,
  connect_timeout: 5,
  connection: { statement_timeout: Number(process.env.DATABASE_STATEMENT_TIMEOUT_MS ?? 5000) },
})

try {
  await migrate(drizzle(client), {
    migrationsFolder: new URL('../src/infrastructure/database/drizzle/migrations', import.meta.url).pathname,
  })
} finally {
  await client.end({ timeout: 5 })
}
