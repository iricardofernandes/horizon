import { readFile } from 'node:fs/promises'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { RabbitMQContainer, type StartedRabbitMQContainer } from '@testcontainers/rabbitmq'
import postgres from 'postgres'
import { afterAll, beforeAll } from 'vitest'

let database: StartedPostgreSqlContainer
let rabbitmq: StartedRabbitMQContainer

beforeAll(async () => {
  ;[database, rabbitmq] = await Promise.all([
    new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('horizon_webhooks_test')
      .withUsername('postgres')
      .withPassword('test')
      .start(),
    new RabbitMQContainer('rabbitmq:4-management-alpine').start(),
  ])
  await database.exec([
    'psql',
    '-U',
    'postgres',
    '-d',
    'horizon_webhooks_test',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `CREATE ROLE horizon_owner LOGIN PASSWORD 'test' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
     CREATE ROLE horizon_app LOGIN PASSWORD 'test' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
     CREATE ROLE horizon_relay LOGIN PASSWORD 'test' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
     ALTER DATABASE horizon_webhooks_test OWNER TO horizon_owner;
     REVOKE ALL ON SCHEMA public FROM PUBLIC;
     GRANT USAGE ON SCHEMA public TO horizon_app, horizon_relay;`,
  ])
  const host = database.getHost()
  const port = database.getMappedPort(5432)
  process.env.DATABASE_URL = `postgres://horizon_app:test@${host}:${port}/horizon_webhooks_test`
  process.env.DATABASE_RELAY_URL = `postgres://horizon_relay:test@${host}:${port}/horizon_webhooks_test`
  process.env.DATABASE_MIGRATION_URL = `postgres://horizon_owner:test@${host}:${port}/horizon_webhooks_test`
  process.env.ADMIN_DATABASE_URL = database.getConnectionUri()
  process.env.RABBITMQ_URL = rabbitmq.getAmqpUrl()
  const owner = postgres(process.env.DATABASE_MIGRATION_URL, { max: 1 })
  try {
    const migration = await readFile(
      './src/infrastructure/database/migrations/0000_webhooks.sql',
      'utf8',
    )
    await owner.unsafe(migration)
  } finally {
    await owner.end()
  }
}, 180_000)

afterAll(async () => {
  await Promise.allSettled([database?.stop(), rabbitmq?.stop()])
})
