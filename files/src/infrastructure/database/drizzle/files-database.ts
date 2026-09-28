import { createHash, randomBytes } from 'node:crypto'
import type {
  AttachmentContentType,
  AttachmentDeletionReason,
  AttachmentState,
} from '@horizon/contracts'
import { context, propagation, trace } from '@opentelemetry/api'
import { and, asc, desc, eq, inArray, lte, ne, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { uuidv7 } from 'uuidv7'
import type { AuditRecord, FilesScope, FilesStore, OwnerKey } from '@/application/ports'
import { canonicalJson } from '@/core/audit/canonical-json'
import type { Attachment, Owner, OwnerType } from '@/domain/attachment'
import type { AttachingModule } from '@/domain/records'
import * as schema from './schema'
import type { Database, Transaction } from './transaction'

export interface FilesDatabaseOptions {
  readonly url: string
  readonly poolMax?: number
  readonly statementTimeoutMs?: number
}

type Row = typeof schema.attachments.$inferSelect

function attachmentOf(row: Row): Attachment {
  return {
    id: row.id,
    module: row.module as AttachingModule,
    recordType: row.recordType,
    recordId: row.recordId,
    fileName: row.fileName,
    contentType: row.contentType as AttachmentContentType,
    size: row.size,
    sha256: row.sha256,
    status: row.status as AttachmentState,
    deletionReason: row.deletionReason as AttachmentDeletionReason | null,
    finding: row.finding,
    owner: { type: row.ownerType as OwnerType, id: row.ownerId },
    wrappedDataKey: row.wrappedDataKey,
    objectKey: row.objectKey,
    idempotencyKey: row.idempotencyKey,
    fingerprint: row.fingerprint,
    uploadedBy: row.uploadedBy,
    createdAt: row.createdAt,
    uploadedAt: row.uploadedAt,
    availableAt: row.availableAt,
    expiresAt: row.expiresAt,
    deletedAt: row.deletedAt,
    dueAt: row.dueAt,
    scanAttempts: row.scanAttempts,
  }
}

/** The columns a transition may change; the record, owner and name never do. */
function changesOf(next: Attachment) {
  return {
    sha256: next.sha256,
    status: next.status,
    deletionReason: next.deletionReason,
    finding: next.finding,
    wrappedDataKey: next.wrappedDataKey,
    objectKey: next.objectKey,
    uploadedAt: next.uploadedAt,
    availableAt: next.availableAt,
    expiresAt: next.expiresAt,
    deletedAt: next.deletedAt,
    dueAt: next.dueAt,
    scanAttempts: next.scanAttempts,
  }
}

const GENESIS_HASH = '0'.repeat(64)

/** `hash = sha256(previous_hash || canonical_json(entry))`, as identity's chain (ADR 0025). */
export function auditHash(previousHash: string, entry: Record<string, unknown>): string {
  return createHash('sha256')
    .update(previousHash, 'utf8')
    .update(canonicalJson(entry), 'utf8')
    .digest('hex')
}

const ownerIs = (owner: Owner) =>
  and(eq(schema.ownerKeys.ownerType, owner.type), eq(schema.ownerKeys.ownerId, owner.id))

function ownerKeyOf(row: typeof schema.ownerKeys.$inferSelect): OwnerKey {
  return {
    owner: { type: row.ownerType as OwnerType, id: row.ownerId },
    wrappedKey: row.wrappedKey,
    erasedAt: row.erasedAt,
  }
}

function attachmentsScope(tx: Transaction, tenantId: string): FilesScope['attachments'] {
  const table = schema.attachments
  return {
    async insert(attachment) {
      await tx.insert(table).values({
        ...changesOf(attachment),
        id: attachment.id,
        tenantId,
        module: attachment.module,
        recordType: attachment.recordType,
        recordId: attachment.recordId,
        fileName: attachment.fileName,
        contentType: attachment.contentType,
        size: attachment.size,
        ownerType: attachment.owner.type,
        ownerId: attachment.owner.id,
        idempotencyKey: attachment.idempotencyKey,
        fingerprint: attachment.fingerprint,
        uploadedBy: attachment.uploadedBy,
        createdAt: attachment.createdAt,
      })
    },
    async find(id) {
      const [row] = await tx.select().from(table).where(eq(table.id, id))
      return row ? attachmentOf(row) : null
    },
    async findByKey(idempotencyKey) {
      const [row] = await tx.select().from(table).where(eq(table.idempotencyKey, idempotencyKey))
      return row ? attachmentOf(row) : null
    },
    async replace(expected, next) {
      const moved = await tx
        .update(table)
        .set(changesOf(next))
        .where(
          and(
            eq(table.id, expected.id),
            eq(table.status, expected.status),
            eq(table.scanAttempts, expected.scanAttempts),
            sql`${table.objectKey} is not distinct from ${expected.objectKey}`,
            sql`${table.dueAt} is not distinct from ${expected.dueAt?.toISOString() ?? null}::timestamptz`,
          ),
        )
        .returning({ id: table.id })
      return moved.length === 1
    },
    async ofRecord(record) {
      const rows = await tx
        .select()
        .from(table)
        .where(
          and(
            eq(table.module, record.module),
            eq(table.recordType, record.recordType),
            eq(table.recordId, record.recordId),
            inArray(table.status, ['scanning', 'available', 'quarantined']),
          ),
        )
        .orderBy(desc(table.createdAt))
        .limit(200)
      return rows.map(attachmentOf)
    },
    async ofOwner(owner) {
      const rows = await tx
        .select()
        .from(table)
        .where(
          and(
            eq(table.ownerType, owner.type),
            eq(table.ownerId, owner.id),
            ne(table.status, 'deleted'),
          ),
        )
      return rows.map(attachmentOf)
    },
    async claimDue(now, until, limit) {
      const due = await tx
        .select({ id: table.id })
        .from(table)
        .where(lte(table.dueAt, now))
        .orderBy(asc(table.dueAt))
        .limit(limit)
        .for('update', { skipLocked: true })
      if (due.length === 0) return []
      const rows = await tx
        .update(table)
        .set({ dueAt: until })
        .where(
          inArray(
            table.id,
            due.map((row) => row.id),
          ),
        )
        .returning()
      return rows.map(attachmentOf)
    },
  }
}

function ownerKeysScope(tx: Transaction, tenantId: string): FilesScope['ownerKeys'] {
  const table = schema.ownerKeys
  return {
    async find(owner) {
      const [row] = await tx.select().from(table).where(ownerIs(owner))
      return row ? ownerKeyOf(row) : null
    },
    async create(owner, wrappedKey, now) {
      await tx
        .insert(table)
        .values({ tenantId, ownerType: owner.type, ownerId: owner.id, wrappedKey, createdAt: now })
        .onConflictDoNothing()
      const [row] = await tx.select().from(table).where(ownerIs(owner))
      if (!row) throw new Error('The owner key was not stored')
      return ownerKeyOf(row)
    },
    async shred(owner, now) {
      await tx
        .insert(table)
        .values({
          tenantId,
          ownerType: owner.type,
          ownerId: owner.id,
          wrappedKey: null,
          erasedAt: now,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: [table.tenantId, table.ownerType, table.ownerId],
          set: {
            wrappedKey: null,
            erasedAt: sql`coalesce(${table.erasedAt}, ${now.toISOString()}::timestamptz)`,
          },
        })
    },
  }
}

async function appendAudit(tx: Transaction, tenantId: string, record: AuditRecord) {
  // A per-tenant transaction lock serializes chain appends, including the first link.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`files.audit:${tenantId}`}, 0))`,
  )
  const [last] = await tx
    .select({ sequence: schema.auditLog.sequence, hash: schema.auditLog.hash })
    .from(schema.auditLog)
    .orderBy(desc(schema.auditLog.sequence))
    .limit(1)
  const entry = {
    sequence: (last?.sequence ?? 0) + 1,
    tenantId,
    actor: record.actor,
    subjectType: 'attachment',
    subjectId: record.attachmentId,
    action: record.action,
    occurredAt: record.occurredAt,
    requestId: record.requestId,
    traceId: trace.getSpan(context.active())?.spanContext().traceId ?? null,
    details: JSON.parse(canonicalJson(record.details)) as Record<string, unknown>,
  }
  const previousHash = last?.hash ?? GENESIS_HASH
  await tx
    .insert(schema.auditLog)
    .values({ id: uuidv7(), ...entry, previousHash, hash: auditHash(previousHash, entry) })
}

function scopeOf(tx: Transaction, tenantId: string): FilesScope {
  return {
    attachments: attachmentsScope(tx, tenantId),
    ownerKeys: ownerKeysScope(tx, tenantId),
    removals: {
      async append(removal) {
        await tx.insert(schema.attachmentRemovals).values({ id: uuidv7(), tenantId, ...removal })
      },
    },
    audit: { append: (record) => appendAudit(tx, tenantId, record) },
    outbox: {
      async append(event) {
        const id = uuidv7()
        const carrier: Record<string, string> = {}
        propagation.inject(context.active(), carrier)
        await tx.insert(schema.outbox).values({
          id,
          eventId: id,
          tenantId,
          eventType: event.eventType,
          eventVersion: 1,
          occurredAt: event.occurredAt,
          traceId:
            trace.getSpan(context.active())?.spanContext().traceId ??
            randomBytes(16).toString('hex'),
          traceParent: carrier.traceparent ?? null,
          payload: event.payload,
        })
      },
    },
    inbox: {
      async claim(sourceModule, eventId, eventType) {
        const claimed = await tx
          .insert(schema.inbox)
          .values({ sourceModule, eventId, eventType, tenantId })
          .onConflictDoNothing()
          .returning({ eventId: schema.inbox.eventId })
        return claimed.length > 0
      },
    },
  }
}

/** Owns the connection; only tenant-bound scopes leave this module (ADR 0017). */
export class FilesDatabase implements FilesStore {
  readonly #client: ReturnType<typeof postgres>
  readonly #db: Database

  constructor(options: FilesDatabaseOptions) {
    this.#client = postgres(options.url, {
      max: options.poolMax ?? 10,
      connect_timeout: 5,
      connection: { statement_timeout: options.statementTimeoutMs ?? 5000 },
    })
    this.#db = drizzle(this.#client, { schema })
  }

  inTenant<T>(tenantId: string, work: (scope: FilesScope) => Promise<T>): Promise<T> {
    return this.#db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_tenant', ${tenantId}, true)`)
      await tx.insert(schema.tenants).values({ id: tenantId }).onConflictDoNothing()
      return work(scopeOf(tx, tenantId))
    })
  }

  async ping(): Promise<void> {
    await this.#db.execute(sql`select 1`)
  }

  async close(): Promise<void> {
    await this.#client.end({ timeout: 5 })
  }
}

/** Asks across tenants only which ones have due attachments, as the relay role. */
export class RelayDueScan {
  readonly #client: ReturnType<typeof postgres>

  constructor(url: string) {
    this.#client = postgres(url, {
      max: 1,
      connect_timeout: 5,
      connection: { statement_timeout: 5000 },
    })
  }

  async tenantsWithWork(now: Date): Promise<string[]> {
    const rows = await this.#client`
      select distinct tenant_id from attachments where due_at <= ${now.toISOString()}::timestamptz`
    return rows.map((row) => String(row.tenant_id))
  }

  close(): Promise<void> {
    return this.#client.end({ timeout: 5 })
  }
}
