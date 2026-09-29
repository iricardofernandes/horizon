import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgresClient from 'postgres'
import { afterAll, beforeAll } from 'vitest'

/**
 * Hermetic infrastructure for the e2e suite (ADR 0013): a PostgreSQL cluster of its own, so
 * the unprivileged application role RLS depends on is real. The agent has no broker.
 */
let postgres: StartedPostgreSqlContainer

const OWNER_ROLE = 'horizon_owner'
const APP_ROLE = 'horizon_app'

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('horizon_test')
    .withUsername('postgres')
    .withPassword('test')
    .start()
  // A role with BYPASSRLS would make every isolation test pass vacuously.
  await postgres.exec([
    'psql',
    '-U',
    'postgres',
    '-d',
    'horizon_test',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `CREATE ROLE ${OWNER_ROLE} LOGIN PASSWORD 'test' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
     CREATE ROLE ${APP_ROLE} LOGIN PASSWORD 'test' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
     ALTER DATABASE horizon_test OWNER TO ${OWNER_ROLE};
     REVOKE ALL ON SCHEMA public FROM PUBLIC;
     GRANT USAGE ON SCHEMA public TO ${APP_ROLE};`,
  ])
  const host = postgres.getHost()
  const port = postgres.getMappedPort(5432)
  process.env.DATABASE_URL = `postgres://${APP_ROLE}:test@${host}:${port}/horizon_test`
  process.env.ADMIN_DATABASE_URL = postgres.getConnectionUri()
  process.env.DATABASE_MIGRATION_URL = `postgres://${OWNER_ROLE}:test@${host}:${port}/horizon_test`
  const migrationClient = postgresClient(process.env.DATABASE_MIGRATION_URL, { max: 1 })
  try {
    await migrate(drizzle(migrationClient), {
      migrationsFolder: './src/infrastructure/database/drizzle/migrations',
    })
  } finally {
    await migrationClient.end()
  }
}, 180_000)

afterAll(async () => {
  await postgres?.stop()
})
