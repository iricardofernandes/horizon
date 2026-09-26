import { z } from 'zod'
import { FiscalProjections } from './projections'

const config = z
  .object({
    DATABASE_URL: z.url(),
    FISCAL_ARTIFACT_KEY_HEX: z.string().regex(/^[0-9a-f]{64}$/i),
    TENANT_ID: z.uuid(),
  })
  .parse(process.env)

/** Builds the blind supplier tax-id index for parties projected before Phase 44. */
async function run(): Promise<void> {
  const projections = new FiscalProjections(
    config.DATABASE_URL,
    Buffer.from(config.FISCAL_ARTIFACT_KEY_HEX, 'hex'),
  )
  try {
    const indexed = await projections.reindexParties(config.TENANT_ID)
    console.log(JSON.stringify({ tenantId: config.TENANT_ID, indexed }))
  } catch (error) {
    console.error('Fiscal party reindex failed', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    })
    process.exitCode = 1
  } finally {
    await projections.close()
  }
}

void run()
