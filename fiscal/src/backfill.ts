import { createHash } from 'node:crypto'
import postgres from 'postgres'
import { z } from 'zod'
import type { FiscalProjections } from './projections'

const partyPageSchema = z.strictObject({
  tenantId: z.uuid(),
  data: z.array(z.strictObject({ partyId: z.uuid(), revision: z.number().int().positive() })),
  nextCursor: z.uuid().nullable(),
})
const classificationPageSchema = z.strictObject({
  tenantId: z.uuid(),
  data: z.array(z.strictObject({ itemId: z.uuid(), revision: z.number().int().positive() })),
  nextCursor: z.uuid().nullable(),
})
const issuerRevisionSchema = z.strictObject({
  tenantId: z.uuid(),
  data: z.array(z.strictObject({ revision: z.number().int().positive() })).max(1),
})

export interface OwnerFiscalClient {
  listParties(limit: number, cursor: string | null): Promise<unknown>
  partyRevision(partyId: string, revision: number): Promise<unknown>
  issuerRevisions(): Promise<unknown>
  issuerRevision(revision: number): Promise<unknown>
  listClassifications(limit: number, cursor: string | null): Promise<unknown>
  classificationRevision(itemId: string, revision: number): Promise<unknown>
}

/** All requests carry a dedicated, tenant-scoped token. Bodies are never logged. */
export class HttpOwnerFiscalClient implements OwnerFiscalClient {
  constructor(
    private readonly urls: { parties: string; identity: string; catalog: string },
    private readonly token: string | (() => Promise<string>),
  ) {}

  listParties(limit: number, cursor: string | null) {
    return this.get(
      'parties',
      `/parties/fiscal-profiles?limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`,
    )
  }

  partyRevision(partyId: string, revision: number) {
    return this.get('parties', `/parties/${partyId}/fiscal-profile/${revision}`)
  }

  issuerRevisions() {
    return this.get('identity', '/workspace/company/fiscal-profiles')
  }

  issuerRevision(revision: number) {
    return this.get('identity', `/workspace/company/fiscal-profile/${revision}`)
  }

  listClassifications(limit: number, cursor: string | null) {
    return this.get(
      'catalog',
      `/items/classifications?limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`,
    )
  }

  classificationRevision(itemId: string, revision: number) {
    return this.get('catalog', `/items/${itemId}/classification/${revision}`)
  }

  private async get(owner: keyof HttpOwnerFiscalClient['urls'], path: string): Promise<unknown> {
    const token = typeof this.token === 'string' ? this.token : await this.token()
    const response = await fetch(new URL(path, this.urls[owner]), {
      headers: { Authorization: `Bearer ${token}`, 'Cache-Control': 'no-store' },
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) throw new Error(`${owner} fiscal export failed: HTTP ${response.status}`)
    return response.json()
  }
}

export interface BackfillResult {
  readonly source: 'parties' | 'identity' | 'catalog'
  readonly observedCount: number
  readonly digest: string
}

export interface BackfillReconciliation extends BackfillResult {
  readonly checkpointCount: number
  readonly projectedCount: number
}

/** Resume after each whole page; replaying a page is harmless because revisions are unique. */
export class FiscalBackfill {
  readonly #db: ReturnType<typeof postgres>

  constructor(
    url: string,
    private readonly projections: FiscalProjections,
    private readonly owner: OwnerFiscalClient,
  ) {
    this.#db = postgres(url, { max: 3, connection: { statement_timeout: 5000 } })
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  /** Compare the source scan with the committed checkpoint and local projection. */
  async reconcile(tenantId: string, result: BackfillResult): Promise<BackfillReconciliation> {
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      const [checkpoint] = await tx`select observed_count, digest, completed_at
        from backfill_checkpoints where tenant_id = ${tenantId}
          and source_module = ${result.source}`
      if (
        !checkpoint?.completed_at ||
        checkpoint.observed_count !== result.observedCount ||
        checkpoint.digest !== result.digest
      )
        throw new Error('Fiscal backfill checkpoint does not match its source scan')
      const [projection] =
        result.source === 'catalog'
          ? await tx`select count(*)::integer as total from catalog_classifications
              where tenant_id = ${tenantId}`
          : await tx`select count(*)::integer as total from profile_revisions
              where tenant_id = ${tenantId} and source_module = ${result.source}`
      const projectedCount = projection?.total as number
      if (projectedCount < result.observedCount)
        throw new Error('Fiscal projection has fewer revisions than the source scan')
      return {
        ...result,
        checkpointCount: checkpoint.observed_count as number,
        projectedCount,
      }
    })
  }

  async parties(tenantId: string, limit = 100): Promise<BackfillResult> {
    const progress = await this.start(tenantId, 'parties')
    let cursor = progress.cursor
    let count = progress.count
    let digest = progress.digest
    for (;;) {
      const page = partyPageSchema.parse(await this.owner.listParties(limit, cursor))
      if (page.tenantId !== tenantId) throw new Error('Parties backfill tenant mismatch')
      assertCursorPage(
        page.data.map((row) => row.partyId),
        cursor,
        page.nextCursor,
        limit,
      )
      for (const party of page.data) {
        for (let revision = 1; revision <= party.revision; revision += 1) {
          const record = await this.owner.partyRevision(party.partyId, revision)
          await this.projections.storeParty(tenantId, party.partyId, revision, record)
          digest = step(digest, `${party.partyId}:${revision}`)
          count += 1
        }
      }
      cursor = page.nextCursor
      await this.save(tenantId, 'parties', cursor, count, digest, cursor === null)
      if (cursor === null) return { source: 'parties', observedCount: count, digest }
    }
  }

  async issuer(tenantId: string): Promise<BackfillResult> {
    const listed = issuerRevisionSchema.parse(await this.owner.issuerRevisions())
    if (listed.tenantId !== tenantId) throw new Error('Issuer backfill tenant mismatch')
    const current = listed.data[0]?.revision ?? 0
    let digest = ''
    for (let revision = 1; revision <= current; revision += 1) {
      const record = await this.owner.issuerRevision(revision)
      await this.projections.storeIssuer(tenantId, revision, record)
      digest = step(digest, `${tenantId}:${revision}`)
    }
    await this.save(tenantId, 'identity', null, current, digest, true)
    return { source: 'identity', observedCount: current, digest }
  }

  async catalog(tenantId: string, limit = 100): Promise<BackfillResult> {
    const progress = await this.start(tenantId, 'catalog')
    let cursor = progress.cursor
    let count = progress.count
    let digest = progress.digest
    for (;;) {
      const page = classificationPageSchema.parse(
        await this.owner.listClassifications(limit, cursor),
      )
      if (page.tenantId !== tenantId) throw new Error('Catalog backfill tenant mismatch')
      assertCursorPage(
        page.data.map((row) => row.itemId),
        cursor,
        page.nextCursor,
        limit,
      )
      for (const item of page.data) {
        for (let revision = 1; revision <= item.revision; revision += 1) {
          const record = await this.owner.classificationRevision(item.itemId, revision)
          await this.projections.storeClassification(tenantId, item.itemId, revision, record)
          digest = step(digest, `${item.itemId}:${revision}`)
          count += 1
        }
      }
      cursor = page.nextCursor
      await this.save(tenantId, 'catalog', cursor, count, digest, cursor === null)
      if (cursor === null) return { source: 'catalog', observedCount: count, digest }
    }
  }

  private async start(tenantId: string, source: BackfillResult['source']) {
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      await tx`insert into tenants (id) values (${tenantId}) on conflict do nothing`
      const [row] = await tx`select cursor, observed_count, digest, completed_at
        from backfill_checkpoints where tenant_id = ${tenantId} and source_module = ${source}`
      if (row?.completed_at) return { cursor: null, count: 0, digest: '' }
      return {
        cursor: (row?.cursor as string | null | undefined) ?? null,
        count: (row?.observed_count as number | undefined) ?? 0,
        digest: (row?.digest as string | undefined) ?? '',
      }
    })
  }

  private async save(
    tenantId: string,
    source: BackfillResult['source'],
    cursor: string | null,
    count: number,
    digest: string,
    complete: boolean,
  ): Promise<void> {
    await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      await tx`insert into backfill_checkpoints
        (tenant_id, source_module, cursor, observed_count, digest, completed_at)
        values (${tenantId}, ${source}, ${cursor}, ${count}, ${digest}, ${complete ? new Date() : null})
        on conflict (tenant_id, source_module) do update set
          cursor = excluded.cursor, observed_count = excluded.observed_count,
          digest = excluded.digest, completed_at = excluded.completed_at,
          last_run_at = now()`
    })
  }
}

function step(previous: string, value: string): string {
  return createHash('sha256').update(`${previous}\n${value}`).digest('hex')
}

function assertCursorPage(
  ids: readonly string[],
  cursor: string | null,
  next: string | null,
  limit: number,
): void {
  if (ids.length > limit) throw new Error('Owner backfill page exceeds the requested limit')
  let previous = cursor
  for (const id of ids) {
    if (previous !== null && id <= previous)
      throw new Error('Owner backfill cursor order is invalid')
    previous = id
  }
  if (next !== null && (ids.length === 0 || next !== ids.at(-1)))
    throw new Error('Owner backfill cursor does not name the last row')
}
