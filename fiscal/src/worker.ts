import { z } from 'zod'
import { HttpOwnerFiscalClient } from './backfill'
import { FiscalConsumer } from './consumer'
import { FiscalIngress } from './ingress'
import { FiscalProjections } from './projections'
import { FiscalServiceTokens } from './service-tokens'

const config = z
  .object({
    DATABASE_URL: z.url(),
    RABBITMQ_URL: z.url(),
    PARTIES_URL: z.url(),
    IDENTITY_URL: z.url(),
    CATALOG_URL: z.url(),
    FISCAL_SERVICE_KEYS_JSON: z.string().min(2).max(100_000),
  })
  .parse(process.env)

const ingress = new FiscalIngress(config.DATABASE_URL)
const projections = new FiscalProjections(config.DATABASE_URL)
const keys = z
  .record(z.uuid(), z.string().min(20))
  .parse(JSON.parse(config.FISCAL_SERVICE_KEYS_JSON))
if (Object.keys(keys).length === 0) throw new Error('At least one fiscal service key is required')
const tokens = new FiscalServiceTokens(config.IDENTITY_URL, keys)
const urls = {
  parties: config.PARTIES_URL,
  identity: config.IDENTITY_URL,
  catalog: config.CATALOG_URL,
}
const consumer = new FiscalConsumer(
  config.RABBITMQ_URL,
  ingress,
  projections,
  (tenantId) => new HttpOwnerFiscalClient(urls, () => tokens.forTenant(tenantId)),
)

async function stop(): Promise<void> {
  await consumer.close()
  await Promise.all([ingress.close(), projections.close()])
}

process.once('SIGTERM', () => void stop().then(() => process.exit(0)))
process.once('SIGINT', () => void stop().then(() => process.exit(0)))

void consumer.start().catch(async (error: unknown) => {
  console.error('Fiscal consumer startup failed', {
    errorType: error instanceof Error ? error.name : 'UnknownError',
  })
  await Promise.allSettled([ingress.close(), projections.close()])
  process.exitCode = 1
})
