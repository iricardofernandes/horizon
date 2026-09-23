import { createHash, randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { z } from 'zod'
import type { FiscalArtifactStore } from './artifact-store'
import { appendAudit } from './audit'

const metadataSchema = z.object({
  tenantId: z.uuid(),
  documentId: z.uuid(),
  kind: z.enum([
    'xml',
    'response',
    'protocol',
    'pdf',
    'unsigned_xml',
    'signed_xml',
    'issuance_request',
    'issuance_response',
    'authorization_protocol',
    'cancellation_request',
    'cancellation_response',
    'cancellation_protocol',
    'danfe',
  ]),
  commandId: z.uuid().optional(),
  mediaType: z.string().min(3).max(100),
  sourceSchema: z.string().min(1).max(160),
})

export type ArtifactMetadata = z.infer<typeof metadataSchema> & {
  digest: string
  size: number
  createdAt: string
}

/** Metadata and bytes are separate: PostgreSQL is authoritative for tenant access. */
export class FiscalArtifacts {
  readonly #db: ReturnType<typeof postgres>

  constructor(
    databaseUrl: string,
    private readonly store: FiscalArtifactStore,
  ) {
    this.#db = postgres(databaseUrl, { max: 10, connection: { statement_timeout: 5000 } })
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  async list(
    tenantId: string,
    documentId: string,
  ): Promise<{
    documentId: string
    artifacts: Array<{
      documentId: string
      kind: string
      digest: string
      byteSize: number
      mediaType: string
      sourceSchema: string
      simulated: true
      createdAt: string
    }>
  } | null> {
    z.uuid().parse(tenantId)
    z.uuid().parse(documentId)
    const result = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      const [document] = await tx`select id from fiscal_documents
        where tenant_id = ${tenantId} and id = ${documentId}`
      if (!document) return null
      return tx`select purpose, digest, size_bytes, media_type, source_schema, created_at
        from fiscal_artifacts where tenant_id = ${tenantId} and document_id = ${documentId}
          and purpose is not null order by created_at, id`
    })
    if (!result) return null
    return {
      documentId,
      artifacts: result.map((row) => ({
        documentId,
        kind: String(row.purpose),
        digest: String(row.digest),
        byteSize: Number(row.size_bytes),
        mediaType: String(row.media_type),
        sourceSchema: String(row.source_schema),
        simulated: true as const,
        createdAt: new Date(row.created_at).toISOString(),
      })),
    }
  }

  async put(input: z.input<typeof metadataSchema>, bytes: Buffer): Promise<ArtifactMetadata> {
    const value = metadataSchema.parse(input)
    if (bytes.length > 10 * 1024 * 1024) throw new Error('Fiscal artifact exceeds 10 MiB')
    const digest = createHash('sha256').update(bytes).digest('hex')
    const objectKey = `${value.tenantId}/${value.documentId}/${value.kind}/${digest}`
    const documentExists = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${value.tenantId}, true)`
      const rows = await tx`select id from fiscal_documents
        where tenant_id = ${value.tenantId} and id = ${value.documentId}`
      return rows.length > 0
    })
    if (!documentExists) throw new Error('Fiscal document not found')
    await this.store.put(objectKey, bytes)
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${value.tenantId}, true)`
      const inserted = await tx`insert into fiscal_artifacts (
        id, tenant_id, document_id, kind, purpose, command_id, object_key, digest,
        size_bytes, media_type, source_schema
      ) values (
        ${randomUUID()}, ${value.tenantId}, ${value.documentId}, ${value.kind},
        ${isExplicitPurpose(value.kind) ? value.kind : null}, ${value.commandId ?? null},
        ${objectKey}, ${digest}, ${bytes.length}, ${value.mediaType}, ${value.sourceSchema}
      ) on conflict do nothing returning id`
      if (inserted.length > 0)
        await appendAudit(tx, {
          tenantId: value.tenantId,
          actorId: 'system:fiscal',
          action: 'document.artifact-stored',
          resourceId: value.documentId,
          detail: { kind: value.kind, digest },
        })
      const [row] = await tx`select digest, size_bytes, media_type, source_schema, created_at
        from fiscal_artifacts where tenant_id = ${value.tenantId}
          and document_id = ${value.documentId} and kind = ${value.kind} and digest = ${digest}`
      if (
        !row ||
        Number(row.size_bytes) !== bytes.length ||
        row.media_type !== value.mediaType ||
        row.source_schema !== value.sourceSchema
      )
        throw new Error('Conflicting fiscal artifact metadata')
      return {
        ...value,
        digest,
        size: bytes.length,
        createdAt: new Date(row.created_at).toISOString(),
      }
    })
  }

  async get(
    tenantId: string,
    documentId: string,
    kind: ArtifactMetadata['kind'],
    digest: string,
  ): Promise<{
    metadata: ArtifactMetadata
    bytes: Buffer
  }> {
    z.uuid().parse(tenantId)
    z.uuid().parse(documentId)
    metadataSchema.shape.kind.parse(kind)
    z.string()
      .regex(/^[0-9a-f]{64}$/)
      .parse(digest)
    const [row] = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select object_key, size_bytes, media_type, source_schema, created_at
        from fiscal_artifacts where tenant_id = ${tenantId} and document_id = ${documentId}
          and kind = ${kind} and digest = ${digest}`
    })
    if (!row) throw new Error('Fiscal artifact not found')
    const bytes = await this.store.get(String(row.object_key))
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== digest || bytes.length !== Number(row.size_bytes))
      throw new Error('Fiscal artifact digest mismatch')
    return {
      metadata: {
        tenantId,
        documentId,
        kind,
        digest,
        size: bytes.length,
        mediaType: String(row.media_type),
        sourceSchema: String(row.source_schema),
        createdAt: new Date(row.created_at).toISOString(),
      },
      bytes,
    }
  }
}

function isExplicitPurpose(kind: ArtifactMetadata['kind']): boolean {
  return !['xml', 'response', 'protocol', 'pdf'].includes(kind)
}
