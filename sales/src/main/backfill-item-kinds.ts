import { z } from 'zod'
import { AesGcmSecretBox } from '@/infrastructure/cryptography/aes-gcm-secret-box'
import { SalesDatabase } from '@/infrastructure/database/drizzle/sales-database'

/**
 * Fills the kind of catalog items Sales projected before Phase 49.
 *
 * The Catalog kind is immutable and published on `catalog.item.created`, so new items
 * arrive with it; older rows are read once from the Catalog API. Only unknown kinds are
 * filled, so running it again changes nothing.
 *
 *   CATALOG_URL=http://localhost:8000/catalog CATALOG_TOKEN=<catalog:viewer token> \
 *     npm run backfill:item-kinds -- --tenant <uuid>
 */
const PAGE = 100

const itemSchema = z.object({ id: z.uuid(), kind: z.enum(['product', 'service']) })
const pageSchema = z.object({
  data: z.array(itemSchema),
  page: z.object({ hasMore: z.boolean(), nextCursor: z.string().optional() }),
})

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? undefined : process.argv[index + 1]
}

async function catalogKinds(
  url: string,
  token: string,
): Promise<Map<string, 'product' | 'service'>> {
  const kinds = new Map<string, 'product' | 'service'>()
  let cursor: string | undefined
  do {
    const query = new URLSearchParams({ limit: String(PAGE), ...(cursor ? { cursor } : {}) })
    const response = await fetch(`${url.replace(/\/$/, '')}/items?${query}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) throw new Error(`Catalog items read failed with HTTP ${response.status}`)
    const page = pageSchema.parse(await response.json())
    for (const item of page.data) kinds.set(item.id, item.kind)
    cursor = page.page.hasMore ? page.page.nextCursor : undefined
  } while (cursor)
  return kinds
}

async function main(): Promise<void> {
  const tenantId = z.uuid().parse(flag('tenant'))
  const config = z
    .object({
      DATABASE_URL: z.url(),
      CATALOG_URL: z.url(),
      CATALOG_TOKEN: z.string().min(20),
      CUSTOMER_BLIND_INDEX_KEY: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .parse(process.env)
  const kinds = await catalogKinds(config.CATALOG_URL, config.CATALOG_TOKEN)
  const database = new SalesDatabase({
    url: config.DATABASE_URL,
    poolMax: 2,
    statementTimeoutMs: 10_000,
    customerPrivacy: {
      secretBox: new AesGcmSecretBox(),
      blindIndexKey: Buffer.from(config.CUSTOMER_BLIND_INDEX_KEY, 'hex'),
    },
  })
  try {
    const result = await database.inTenant(tenantId, async (scope) => {
      const unknown = await scope.catalogItems.unknownKinds(10_000)
      const filled: { itemId: string; kind: string }[] = []
      const missing: string[] = []
      for (const itemId of unknown) {
        const kind = kinds.get(itemId)
        if (!kind) {
          missing.push(itemId)
          continue
        }
        if (await scope.catalogItems.backfillKind(itemId, kind)) filled.push({ itemId, kind })
      }
      if (filled.length)
        await scope.audit.append({
          actor: 'system:backfill-item-kinds',
          action: 'catalog-item.kinds-backfilled',
          subjectType: 'catalog-item',
          subjectId: tenantId,
          occurredAt: new Date(),
          requestId: null,
          details: {
            filled: filled.length,
            services: filled.filter((row) => row.kind === 'service').length,
          },
        })
      return { tenantId, unknownBefore: unknown.length, filled, notInCatalog: missing }
    })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } finally {
    await database.close()
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Backfill failed'}\n`)
  process.exitCode = 1
})
