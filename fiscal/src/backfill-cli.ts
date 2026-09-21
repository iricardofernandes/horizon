import { z } from 'zod'
import { FiscalBackfill, HttpOwnerFiscalClient } from './backfill'
import { FiscalProjections } from './projections'
import { FiscalServiceTokens } from './service-tokens'

const config = z
  .object({
    DATABASE_URL: z.url(),
    PARTIES_URL: z.url(),
    IDENTITY_URL: z.url(),
    CATALOG_URL: z.url(),
    FISCAL_SERVICE_API_KEY: z.string().min(20),
    TENANT_ID: z.uuid(),
  })
  .parse(process.env)

const projections = new FiscalProjections(config.DATABASE_URL)
const tokens = new FiscalServiceTokens(config.IDENTITY_URL, {
  [config.TENANT_ID]: config.FISCAL_SERVICE_API_KEY,
})
const owner = new HttpOwnerFiscalClient(
  { parties: config.PARTIES_URL, identity: config.IDENTITY_URL, catalog: config.CATALOG_URL },
  () => tokens.forTenant(config.TENANT_ID),
)
const backfill = new FiscalBackfill(config.DATABASE_URL, projections, owner)

async function run(): Promise<void> {
  try {
    const scanned = [
      await backfill.parties(config.TENANT_ID),
      await backfill.issuer(config.TENANT_ID),
      await backfill.catalog(config.TENANT_ID),
    ]
    const reconciled = await Promise.all(
      scanned.map((result) => backfill.reconcile(config.TENANT_ID, result)),
    )
    console.log(JSON.stringify(reconciled))
  } catch (error) {
    console.error('Fiscal backfill failed', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    })
    process.exitCode = 1
  } finally {
    await Promise.all([backfill.close(), projections.close()])
  }
}

void run()
