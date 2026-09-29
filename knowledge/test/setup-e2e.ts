import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgresClient from 'postgres'
import { afterAll, beforeAll } from 'vitest'

/**
 * Hermetic infrastructure for the e2e suite (ADR 0013): a PostgreSQL cluster with pgvector,
 * its own roles, and the `vector` extension created by the superuser as the init script does,
 * so the migration runs exactly as it does in the stack.
 */
let postgres: StartedPostgreSqlContainer

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('pgvector/pgvector:0.8.1-pg17')
    .withDatabase('horizon_test')
    .withUsername('postgres')
    .withPassword('test')
    .start()
  await postgres.exec([
    'psql',
    '-U',
    'postgres',
    '-d',
    'horizon_test',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `CREATE ROLE horizon_owner LOGIN PASSWORD 'test' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
     CREATE ROLE horizon_app LOGIN PASSWORD 'test' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
     CREATE ROLE horizon_relay LOGIN PASSWORD 'test' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
     ALTER DATABASE horizon_test OWNER TO horizon_owner;
     REVOKE ALL ON SCHEMA public FROM PUBLIC;
     GRANT USAGE, CREATE ON SCHEMA public TO horizon_owner;
     GRANT USAGE ON SCHEMA public TO horizon_app, horizon_relay;
     CREATE EXTENSION vector;
     ALTER DEFAULT PRIVILEGES FOR ROLE horizon_owner IN SCHEMA public
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO horizon_app;`,
  ])
  const host = postgres.getHost()
  const port = postgres.getMappedPort(5432)
  process.env.DATABASE_URL = `postgres://horizon_app:test@${host}:${port}/horizon_test`
  process.env.DATABASE_RELAY_URL = `postgres://horizon_relay:test@${host}:${port}/horizon_test`
  process.env.ADMIN_DATABASE_URL = postgres.getConnectionUri()
  process.env.DATABASE_MIGRATION_URL = `postgres://horizon_owner:test@${host}:${port}/horizon_test`
  const migrationClient = postgresClient(process.env.DATABASE_MIGRATION_URL, { max: 1 })
  try {
    await migrate(drizzle(migrationClient), {
      migrationsFolder: './src/infrastructure/database/drizzle/migrations',
    })
  } finally {
    await migrationClient.end()
  }
}, 240_000)

afterAll(async () => {
  await postgres?.stop()
})
