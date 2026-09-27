import { z } from 'zod'
import { AesGcmSecretBox } from '@/infrastructure/cryptography/aes-gcm-secret-box'
import { PartiesDatabase } from '@/infrastructure/database/drizzle/parties-database'

/**
 * Fills the duplicate-check indexes of parties registered before Phase 54 (ADR 0057).
 *
 * New and edited parties get them on write; older rows are opened once, per tenant, a
 * page at a time. Only rows without a name index are touched, so running it again changes
 * nothing.
 *
 *   npm run backfill:party-lookups -- --tenant <uuid>
 */
const PAGE = 200

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? undefined : process.argv[index + 1]
}

async function main(): Promise<void> {
  const tenantId = z.uuid().parse(flag('tenant'))
  const config = z
    .object({
      DATABASE_URL: z.url(),
      PARTY_BLIND_INDEX_KEY: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .parse(process.env)
  const database = new PartiesDatabase({
    url: config.DATABASE_URL,
    poolMax: 2,
    statementTimeoutMs: 10_000,
    privacy: {
      secretBox: new AesGcmSecretBox(),
      blindIndexKey: Buffer.from(config.PARTY_BLIND_INDEX_KEY, 'hex'),
    },
  })
  try {
    let filled = 0
    for (let page = await database.backfillLookups(tenantId, PAGE); page > 0; ) {
      filled += page
      page = await database.backfillLookups(tenantId, PAGE)
    }
    process.stdout.write(`${JSON.stringify({ tenantId, filled })}\n`)
  } finally {
    await database.close()
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
