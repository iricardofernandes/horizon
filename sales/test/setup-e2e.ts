import { randomUUID } from 'node:crypto'

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { RabbitMQContainer, type StartedRabbitMQContainer } from '@testcontainers/rabbitmq'
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'
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
let redis: StartedRedisContainer
let rabbitmq: StartedRabbitMQContainer

const OWNER_ROLE = 'horizon_owner'
const APP_ROLE = 'horizon_app'
const APP_PASSWORD = 'test'

beforeAll(async () => {
  ;[postgres, redis, rabbitmq] = await Promise.all([
    new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('horizon_test')
      .withUsername(OWNER_ROLE)
      .withPassword('test')
      .start(),
    new RedisContainer('redis:7-alpine').start(),
    new RabbitMQContainer('rabbitmq:4-management-alpine').start(),
  ])

  // The application role must not be able to bypass RLS. Creating it here, rather
  // than relying on a container default, is what lets the isolation tests be
  // meaningful: a role with BYPASSRLS would make every one of them pass vacuously.
  await postgres.exec([
    'psql',
    '-U',
    OWNER_ROLE,
    '-d',
    'horizon_test',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
  ])

  const host = postgres.getHost()
  const port = postgres.getMappedPort(5432)

  process.env.DATABASE_URL = `postgres://${APP_ROLE}:${APP_PASSWORD}@${host}:${port}/horizon_test`
  process.env.DATABASE_MIGRATION_URL = postgres.getConnectionUri()
  process.env.REDIS_URL = redis.getConnectionUrl()
  process.env.RABBITMQ_URL = rabbitmq.getAmqpUrl()
  process.env.TENANT_ID_HASH_SALT = randomUUID()

  // Migrations are applied here once this module has a schema. Drizzle's migrator
  // is imported lazily so the suite is runnable before the first migration exists.
}, 180_000)

afterAll(async () => {
  await Promise.allSettled([postgres?.stop(), redis?.stop(), rabbitmq?.stop()])
})
