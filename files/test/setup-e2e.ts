import { randomUUID } from 'node:crypto'

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { RabbitMQContainer, type StartedRabbitMQContainer } from '@testcontainers/rabbitmq'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgresClient from 'postgres'
import { afterAll, beforeAll } from 'vitest'

/**
 * Hermetic infrastructure for the e2e suite (ADR 0013).
 *
 * Each run gets its own PostgreSQL cluster, so it can create the unprivileged
 * application role that RLS depends on. That is the whole reason this is not a
 * schema-per-run trick against a shared instance: roles and FORCE ROW LEVEL
 * SECURITY are cluster- and table-scoped, not schema-scoped, and role
 * configuration is precisely what the tenant-isolation tests exercise.
 */

let postgres: StartedPostgreSqlContainer
let rabbitmq: StartedRabbitMQContainer

const OWNER_ROLE = 'horizon_owner'
const APP_ROLE = 'horizon_app'
const APP_PASSWORD = 'test'

beforeAll(async () => {
  ;[postgres, rabbitmq] = await Promise.all([
    new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('horizon_test')
      .withUsername('postgres')
      .withPassword('test')
      .start(),
    new RabbitMQContainer('rabbitmq:4-management-alpine').start(),
  ])

  // The application role must not be able to bypass RLS. Creating it here, rather
  // than relying on a container default, is what lets the isolation tests be
  // meaningful: a role with BYPASSRLS would make every one of them pass vacuously.
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
     CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
     CREATE ROLE horizon_relay LOGIN PASSWORD 'test' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
     ALTER DATABASE horizon_test OWNER TO ${OWNER_ROLE};
     REVOKE ALL ON SCHEMA public FROM PUBLIC;
     GRANT USAGE ON SCHEMA public TO ${APP_ROLE}, horizon_relay;`,
  ])

  const host = postgres.getHost()
  const port = postgres.getMappedPort(5432)

  process.env.DATABASE_URL = `postgres://${APP_ROLE}:${APP_PASSWORD}@${host}:${port}/horizon_test`
  process.env.ADMIN_DATABASE_URL = postgres.getConnectionUri()
  process.env.DATABASE_MIGRATION_URL = `postgres://${OWNER_ROLE}:test@${host}:${port}/horizon_test`
  process.env.RABBITMQ_URL = rabbitmq.getAmqpUrl()
  process.env.TENANT_ID_HASH_SALT = randomUUID()

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
  await Promise.allSettled([postgres?.stop(), rabbitmq?.stop()])
})
