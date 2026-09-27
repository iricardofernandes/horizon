import { z } from 'zod'
import { RepublishPartiesUseCase } from '@/application/use-cases/manage-parties'
import { AesGcmSecretBox } from '@/infrastructure/cryptography/aes-gcm-secret-box'
import { PartiesDatabase } from '@/infrastructure/database/drizzle/parties-database'

/**
 * Republishes every live party of a tenant as `parties.party.updated`, so a consumer that
 * started after they were registered projects them (CRM, Phase 55). Consumers treat it as
 * a refresh, so running it again is harmless; the relay delivers the events.
 *
 *   npm run republish:parties -- --tenant <uuid>
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
    const result = await new RepublishPartiesUseCase(database, {
      now: () => new Date(),
    }).execute({ tenantId, pageSize: PAGE })
    process.stdout.write(`${JSON.stringify({ tenantId, ...result })}\n`)
  } finally {
    await database.close()
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
