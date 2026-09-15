import { AsyncLocalStorage } from 'node:async_hooks'
import { createHmac, randomBytes } from 'node:crypto'
import { cursorPayloadSchema } from '@horizon/contracts'
import { context, propagation, trace } from '@opentelemetry/api'
import { and, count, desc, eq, gt, type SQL, sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { type TenantScope, UnitOfWork } from '@/application/ports/unit-of-work'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import type { DomainEvent } from '@/core/events/domain-event'
import {
  boundedLimit,
  type Page,
  type PaginationParams,
} from '@/core/repositories/pagination-params'
import { AuditEntry } from '@/domain/audit/audit-entry'
import { redact } from '@/domain/audit/redaction'
import { Account } from '@/domain/entities/account'
import { User } from '@/domain/entities/user'
import {
  AccountsRepository,
  type LegacyMembership,
  type WorkspaceMembership,
} from '@/domain/repositories/accounts-repository'
import type { AuditRecord } from '@/domain/repositories/audit-log-repository'
import type { TenantDirectory } from '@/domain/repositories/tenant-directory'
import type { SecretBox } from '@/domain/services/secret-box'
import { Email } from '@/domain/value-objects/email'
import { PasswordHash } from '@/domain/value-objects/password-hash'
import { PersonName } from '@/domain/value-objects/person-name'
import { RoleAssignments } from '@/domain/value-objects/role-assignments'
import { mapApiKey, mapDataSubjectKey, mapTenant, restored } from './mappers'
import * as schema from './schema'

type Database = PostgresJsDatabase<typeof schema>
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

export interface IdentityDatabaseOptions {
  readonly url: string
  readonly secretBox: SecretBox
  readonly blindIndexKey: Uint8Array
  readonly poolMax?: number
  readonly statementTimeoutMs?: number
}

export interface ReceivedEvent {
  readonly sourceModule: string
  readonly eventId: string
  readonly eventType: string
}

/** Owns the connection; only tenant-bound repositories leave this module (ADR 0017). */
export class IdentityDatabase extends UnitOfWork {
  readonly #client: ReturnType<typeof postgres>
  readonly #db: Database
  readonly #transactions = new AsyncLocalStorage<{ tx: Transaction; tenantId: string }>()
  readonly #options: IdentityDatabaseOptions
  readonly directory: TenantDirectory
  readonly accounts: AccountsRepository

  constructor(options: IdentityDatabaseOptions) {
    super()
    if (options.blindIndexKey.byteLength < 32)
      throw new Error('Blind index key must have at least 32 bytes')
    this.#options = options
    this.#client = postgres(options.url, {
      max: options.poolMax ?? 10,
      connect_timeout: 5,
      connection: { statement_timeout: options.statementTimeoutMs ?? 5000 },
    })
    this.#db = drizzle(this.#client, { schema })
    this.directory = {
      resolve: async (slug) => {
        const [row] = await this.#db
          .select()
          .from(schema.tenantDirectory)
          .where(eq(schema.tenantDirectory.slug, slug))
          .limit(1)
        return row?.tenantId ?? null
      },
      slugExists: async (slug) => (await this.directory.resolve(slug)) !== null,
      register: async (slug, tenantId) => {
        const current = this.#transactions.getStore()
        if (!current || current.tenantId !== tenantId)
          throw new Error('Directory registration requires its tenant transaction')
        await current.tx.insert(schema.tenantDirectory).values({ slug, tenantId })
      },
    }
    this.accounts = {
      findByEmail: (email) => this.findAccountByEmail(email.value),
      findLegacyMemberships: (email) => this.legacyMemberships(email.value),
      provisionFromLegacy: (email, membership) =>
        this.provisionAccountFromLegacy(email.value, membership),
      reconcileMemberships: (accountId, memberships) =>
        this.reconcileAccountMemberships(accountId, memberships),
      listWorkspaces: (accountId) => this.listAccountWorkspaces(accountId),
      findMembership: (accountId, tenantId) => this.findAccountMembership(accountId, tenantId),
      findAccountIdByMembership: (tenantId, userId) =>
        this.findAccountIdByMembership(tenantId, userId),
      save: (account) => this.saveAccount(account),
    }
  }

  async inTenant<T>(tenantId: string, work: (scope: TenantScope) => Promise<T>): Promise<T> {
    if (this.#transactions.getStore())
      throw new Error('Nested tenant transactions are not supported')
    return this.#db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_tenant', ${tenantId}, true)`)
      return this.#transactions.run({ tx, tenantId }, () =>
        work(makeScope(tx, tenantId, this.#options)),
      )
    })
  }

  async ping(): Promise<void> {
    await this.#db.execute(sql`select 1`)
  }

  /** The inbox claim and its effect commit together; rollback allows delivery to retry. */
  async processEvent<T>(
    tenantId: string,
    event: ReceivedEvent,
    work: (scope: TenantScope) => Promise<T>,
  ): Promise<{ processed: false } | { processed: true; value: T }> {
    return this.inTenant(tenantId, async (scope) => {
      const current = this.#transactions.getStore()
      if (!current) throw new Error('Inbox processing requires its tenant transaction')
      const claimed = await current.tx
        .insert(schema.inbox)
        .values({ ...event, tenantId })
        .onConflictDoNothing({ target: [schema.inbox.sourceModule, schema.inbox.eventId] })
        .returning({ eventId: schema.inbox.eventId })
      if (claimed.length === 0) return { processed: false as const }
      return { processed: true as const, value: await work(scope) }
    })
  }
  async close(): Promise<void> {
    await this.#client.end({ timeout: 5 })
  }

  private globalEmailIndex(email: string): string {
    return createHmac('sha256', this.#options.blindIndexKey).update(email).digest('hex')
  }

  private async findAccountByEmail(email: string): Promise<Account | null> {
    const [entry] = await this.#db
      .select()
      .from(schema.accountDirectory)
      .where(eq(schema.accountDirectory.emailIndex, this.globalEmailIndex(email)))
      .limit(1)
    if (!entry) return null
    return this.#db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_account', ${entry.accountId}, true)`)
      const [row] = await tx
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, entry.accountId))
        .limit(1)
      return row ? mapAccount(row) : null
    })
  }

  private async legacyMemberships(email: string): Promise<readonly LegacyMembership[]> {
    const workspaces = await this.#db
      .select({ tenantId: schema.tenantDirectory.tenantId, slug: schema.tenantDirectory.slug })
      .from(schema.tenantDirectory)
      .orderBy(schema.tenantDirectory.slug)
    const matches: LegacyMembership[] = []
    for (const workspace of workspaces) {
      const match = await this.inTenant(workspace.tenantId, async (scope) => {
        const user = await scope.users.findByEmail(restored(Email.create(email)))
        if (!user) return null
        const tenant = await scope.tenants.findById(workspace.tenantId)
        if (!tenant) return null
        return { ...workspace, name: tenant.toSnapshot().name, user }
      })
      if (match) matches.push(match)
    }
    return matches
  }

  private async provisionAccountFromLegacy(
    email: string,
    membership: LegacyMembership,
  ): Promise<Account> {
    const now = new Date()
    const snapshot = membership.user.toSnapshot()
    const accountId = snapshot.id
    await this.#db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_account', ${accountId}, true)`)
      await tx
        .insert(schema.accounts)
        .values({
          id: accountId,
          passwordHash: snapshot.passwordHash,
          status: 'active',
          lastLoginAt: snapshot.lastLoginAt,
          createdAt: snapshot.createdAt,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: schema.accounts.id })
      await tx
        .insert(schema.accountDirectory)
        .values({ emailIndex: this.globalEmailIndex(email), accountId })
        .onConflictDoNothing({ target: schema.accountDirectory.emailIndex })
    })
    const account = await this.findAccountByEmail(email)
    if (!account) throw new Error('Global account provisioning did not become visible')
    return account
  }

  private async reconcileAccountMemberships(
    accountId: string,
    memberships: readonly LegacyMembership[],
  ): Promise<void> {
    for (const membership of memberships) {
      const now = new Date()
      await this.#db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.current_account', ${accountId}, true)`)
        await tx.execute(sql`select set_config('app.current_tenant', ${membership.tenantId}, true)`)
        const [row] = await tx
          .select({ accountId: schema.users.accountId })
          .from(schema.users)
          .where(eq(schema.users.id, membership.user.id.toString()))
          .limit(1)
        if (row?.accountId && row.accountId !== accountId) return
        await tx
          .update(schema.users)
          .set({ accountId })
          .where(eq(schema.users.id, membership.user.id.toString()))
        await tx
          .insert(schema.accountMemberships)
          .values({
            accountId,
            tenantId: membership.tenantId,
            userId: membership.user.id.toString(),
            workspaceSlug: membership.slug,
            workspaceName: membership.name,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [schema.accountMemberships.accountId, schema.accountMemberships.tenantId],
            set: {
              userId: membership.user.id.toString(),
              workspaceSlug: membership.slug,
              workspaceName: membership.name,
              updatedAt: now,
            },
          })
      })
    }
  }

  private async listAccountWorkspaces(accountId: string): Promise<readonly WorkspaceMembership[]> {
    return this.#db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_account', ${accountId}, true)`)
      const rows = await tx
        .select()
        .from(schema.accountMemberships)
        .orderBy(schema.accountMemberships.workspaceName, schema.accountMemberships.tenantId)
      return rows.map(presentMembership)
    })
  }

  private async findAccountMembership(
    accountId: string,
    tenantId: string,
  ): Promise<WorkspaceMembership | null> {
    return this.#db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_account', ${accountId}, true)`)
      const [row] = await tx
        .select()
        .from(schema.accountMemberships)
        .where(eq(schema.accountMemberships.tenantId, tenantId))
        .limit(1)
      return row ? presentMembership(row) : null
    })
  }

  private async findAccountIdByMembership(
    tenantId: string,
    userId: string,
  ): Promise<string | null> {
    return this.#db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_tenant', ${tenantId}, true)`)
      const [row] = await tx
        .select({ accountId: schema.users.accountId })
        .from(schema.users)
        .where(and(eq(schema.users.tenantId, tenantId), eq(schema.users.id, userId)))
        .limit(1)
      return row?.accountId ?? null
    })
  }

  private async saveAccount(account: Account): Promise<void> {
    const row = account.toSnapshot()
    await this.#db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_account', ${row.id}, true)`)
      await tx
        .update(schema.accounts)
        .set({
          passwordHash: row.passwordHash,
          status: row.status,
          lastLoginAt: row.lastLoginAt,
          updatedAt: row.updatedAt,
        })
        .where(eq(schema.accounts.id, row.id))
    })
  }
}

function mapAccount(row: typeof schema.accounts.$inferSelect): Account {
  if (row.status !== 'active' && row.status !== 'disabled')
    throw new Error('Invalid account status')
  return Account.create(
    {
      passwordHash: restored(PasswordHash.create(row.passwordHash)),
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.lastLoginAt === null ? {} : { lastLoginAt: row.lastLoginAt }),
    },
    new UniqueEntityID(row.id),
  )
}

function presentMembership(
  row: typeof schema.accountMemberships.$inferSelect,
): WorkspaceMembership {
  return {
    accountId: row.accountId,
    tenantId: row.tenantId,
    userId: row.userId,
    slug: row.workspaceSlug,
    name: row.workspaceName,
  }
}

function makeScope(
  tx: Transaction,
  tenantId: string,
  options: IdentityDatabaseOptions,
): TenantScope {
  const assertTenant = (actual: string) => {
    if (actual !== tenantId) throw new Error('Aggregate tenant does not match transaction')
  }
  const publish = async (events: readonly DomainEvent[]) => {
    for (const event of events) await publishEvent(tx, tenantId, event)
  }
  const keys: TenantScope['dataSubjectKeys'] = {
    findBySubject: async (id) => {
      const [row] = await tx
        .select()
        .from(schema.dataSubjectKeys)
        .where(eq(schema.dataSubjectKeys.id, id))
        .limit(1)
      return row ? mapDataSubjectKey(row) : null
    },
    create: async (key) => {
      assertTenant(key.toSnapshot().tenantId)
      await tx.insert(schema.dataSubjectKeys).values(key.toSnapshot())
    },
    save: async (key) => {
      const row = key.toSnapshot()
      assertTenant(row.tenantId)
      await tx
        .update(schema.dataSubjectKeys)
        .set({ material: row.material, erasedAt: row.erasedAt })
        .where(eq(schema.dataSubjectKeys.id, row.id))
    },
  }
  const materialFor = async (subjectId: string): Promise<string> => {
    const material = (await keys.findBySubject(subjectId))?.material()
    if (!material) throw new Error('Data subject key is unavailable')
    return material
  }
  const blindIndex = (email: string) =>
    createHmac('sha256', options.blindIndexKey).update(`${tenantId}:${email}`).digest('hex')
  const mapUser = async (row: typeof schema.users.$inferSelect): Promise<User> => {
    if (!['active', 'disabled', 'erased'].includes(row.status))
      throw new Error('Invalid user status')
    const material = row.status === 'erased' ? null : await materialFor(row.id)
    const open = (field: string, value: string) => {
      const plaintext = options.secretBox.open(`${tenantId}:${row.id}:${field}:${material}`, value)
      if (plaintext === null) throw new Error('Personal data authentication failed')
      return plaintext
    }
    return User.create(
      {
        tenantId: row.tenantId,
        email: restored(
          Email.create(
            material === null ? 'erased@invalid.example' : open('email', row.emailCiphertext),
          ),
        ),
        name: restored(
          PersonName.create(
            material === null ? 'Erased subject' : open('name', row.nameCiphertext),
          ),
        ),
        passwordHash: restored(PasswordHash.create(row.passwordHash)),
        roles: RoleAssignments.of(row.roles),
        status: row.status as 'active' | 'disabled' | 'erased',
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        ...(row.lastLoginAt === null ? {} : { lastLoginAt: row.lastLoginAt }),
      },
      new UniqueEntityID(row.id),
    )
  }
  const personalFields = async (user: User) => {
    const row = user.toSnapshot()
    const material = await materialFor(row.id)
    return {
      emailIndex: blindIndex(row.email),
      emailCiphertext: options.secretBox.seal(`${tenantId}:${row.id}:email:${material}`, row.email),
      nameCiphertext: options.secretBox.seal(`${tenantId}:${row.id}:name:${material}`, row.name),
    }
  }
  const lockUser = async (id: string) => {
    await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, id))
      .for('no key update')
  }
  // Every key workflow acquires user -> key, including export's listIssuedBy path.
  const findLockedKey = async (where: SQL) => {
    const [observed] = await tx.select().from(schema.apiKeys).where(where).limit(1)
    if (!observed) return null
    await lockUser(observed.issuedBy)
    const [row] = await tx.select().from(schema.apiKeys).where(where).limit(1).for('no key update')
    return row ? mapApiKey(row) : null
  }
  return {
    tenantId,
    tenants: {
      findById: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.tenants)
          .where(eq(schema.tenants.id, id))
          .limit(1)
        return row ? mapTenant(row) : null
      },
      create: async (tenant) => {
        assertTenant(tenant.id.toString())
        await tx.insert(schema.tenants).values(tenant.toSnapshot())
        await publish(tenant.pullDomainEvents())
      },
      save: async (tenant) => {
        const row = tenant.toSnapshot()
        assertTenant(row.id)
        await tx.update(schema.tenants).set(row).where(eq(schema.tenants.id, row.id))
        await publish(tenant.pullDomainEvents())
      },
      list: async (params) =>
        page(
          await tx
            .select()
            .from(schema.tenants)
            .where(cursorAfter(schema.tenants.createdAt, schema.tenants.id, params))
            .orderBy(schema.tenants.createdAt, schema.tenants.id)
            .limit(boundedLimit(params.limit) + 1),
          params,
          mapTenant,
        ),
    },
    dataSubjectKeys: keys,
    users: {
      findById: async (id) => {
        const [row] = await tx
          .select()
          .from(schema.users)
          .where(eq(schema.users.id, id))
          .limit(1)
          .for('no key update')
        return row ? mapUser(row) : null
      },
      findByEmail: async (email) => {
        const [row] = await tx
          .select()
          .from(schema.users)
          .where(eq(schema.users.emailIndex, blindIndex(email.value)))
          .limit(1)
          .for('no key update')
        return row ? mapUser(row) : null
      },
      create: async (user) => {
        assertTenant(user.claims().tenantId)
        const { email: _email, name: _name, ...row } = user.toSnapshot()
        await tx
          .insert(schema.users)
          .values({ ...row, roles: [...row.roles], ...(await personalFields(user)) })
        await publish(user.pullDomainEvents())
      },
      save: async (user) => {
        assertTenant(user.claims().tenantId)
        const { email: _email, name: _name, id, tenantId: _tenantId, ...row } = user.toSnapshot()
        const personal = user.isErased()
          ? {
              emailIndex: `erased:${id}`,
              // A syntactically valid tombstone, unrelated to the subject's old credential.
              passwordHash:
                '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            }
          : await personalFields(user)
        await tx
          .update(schema.users)
          .set({ ...row, roles: [...row.roles], ...personal })
          .where(eq(schema.users.id, id))
        await publish(user.pullDomainEvents())
      },
      list: async (params) =>
        page(
          await tx
            .select()
            .from(schema.users)
            .where(cursorAfter(schema.users.createdAt, schema.users.id, params))
            .orderBy(schema.users.createdAt, schema.users.id)
            .limit(boundedLimit(params.limit) + 1),
          params,
          mapUser,
        ),
      countActive: async () => {
        const [row] = await tx
          .select({ value: count() })
          .from(schema.users)
          .where(eq(schema.users.status, 'active'))
        return row?.value ?? 0
      },
    },
    apiKeys: {
      findById: async (id) => findLockedKey(eq(schema.apiKeys.id, id)),
      findByPrefix: async (prefix) => findLockedKey(eq(schema.apiKeys.prefix, prefix)),
      create: async (key) => {
        const row = key.toSnapshot()
        assertTenant(row.tenantId)
        await tx.insert(schema.apiKeys).values({ ...row, scopes: [...row.scopes] })
        await publish(key.pullDomainEvents())
      },
      save: async (key) => {
        const row = key.toSnapshot()
        assertTenant(row.tenantId)
        await tx
          .update(schema.apiKeys)
          .set({ ...row, scopes: [...row.scopes] })
          .where(eq(schema.apiKeys.id, row.id))
        await publish(key.pullDomainEvents())
      },
      list: async (params) =>
        page(
          await tx
            .select()
            .from(schema.apiKeys)
            .where(cursorAfter(schema.apiKeys.createdAt, schema.apiKeys.id, params))
            .orderBy(schema.apiKeys.createdAt, schema.apiKeys.id)
            .limit(boundedLimit(params.limit) + 1),
          params,
          mapApiKey,
        ),
      listIssuedBy: async (id) => {
        await lockUser(id)
        return (
          await tx
            .select()
            .from(schema.apiKeys)
            .where(eq(schema.apiKeys.issuedBy, id))
            .orderBy(schema.apiKeys.id)
            .for('no key update')
        ).map(mapApiKey)
      },
    },
    audit: {
      append: async (record) => appendAudit(tx, tenantId, record, materialFor, options.secretBox),
      walk: async (cursor, limit) =>
        (
          await tx
            .select()
            .from(schema.auditLog)
            .where(gt(schema.auditLog.sequence, cursor))
            .orderBy(schema.auditLog.sequence)
            .limit(limit)
        ).map(mapAudit),
      lastSequence: async () =>
        (
          await tx
            .select({ sequence: schema.auditLog.sequence })
            .from(schema.auditLog)
            .orderBy(desc(schema.auditLog.sequence))
            .limit(1)
        )[0]?.sequence ?? 0,
    },
    outbox: { publish },
  }
}

async function publishEvent(tx: Transaction, tenantId: string, event: DomainEvent): Promise<void> {
  if (event.tenantId !== tenantId) throw new Error('Event tenant does not match transaction')
  const id = new UniqueEntityID().toString()
  const carrier: Record<string, string> = {}
  propagation.inject(context.active(), carrier)
  await tx.insert(schema.outbox).values({
    id,
    eventId: id,
    tenantId,
    eventType: event.eventType,
    eventVersion: event.eventVersion,
    occurredAt: event.occurredAt,
    traceId:
      trace.getSpan(context.active())?.spanContext().traceId ?? randomBytes(16).toString('hex'),
    traceParent: carrier.traceparent ?? null,
    payload: { ...event.payloadOf() },
  })
}

async function appendAudit(
  tx: Transaction,
  tenantId: string,
  record: AuditRecord,
  materialFor: (id: string) => Promise<string>,
  box: SecretBox,
): Promise<AuditEntry> {
  // A tenant row lock serializes chain appends, including the first link.
  const locked = await tx
    .select({ id: schema.tenants.id })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, tenantId))
    .for('no key update')
  if (locked.length === 0) throw new Error('Audit tenant does not exist')
  const [last] = await tx
    .select()
    .from(schema.auditLog)
    .orderBy(desc(schema.auditLog.sequence))
    .limit(1)
  const before = redact(record.before ?? null)
  const after = redact(record.after ?? null)
  const material = record.dataSubjectId ? await materialFor(record.dataSubjectId) : null
  const seal = (value: Record<string, unknown> | null) =>
    value && material
      ? {
          ciphertext: box.seal(
            `${tenantId}:${record.dataSubjectId}:audit:${material}`,
            JSON.stringify(value),
          ),
        }
      : value
  const entry = AuditEntry.append({
    payload: {
      tenantId,
      sequence: (last?.sequence ?? 0) + 1,
      actorType: record.actor.type,
      actorId: record.actor.id,
      subjectType: record.subjectType,
      subjectId: record.subjectId,
      action: record.action,
      occurredAt: record.occurredAt,
      requestId: record.requestId ?? null,
      traceId: record.traceId ?? null,
      sourceIp: record.sourceIp ?? null,
      before: seal(before.data),
      after: seal(after.data),
      redacted: [...new Set([...before.fields, ...after.fields])],
    },
    ...(last ? { previousHash: last.hash } : {}),
  })
  await tx
    .insert(schema.auditLog)
    .values({ ...entry.toSnapshot(), redacted: [...entry.toSnapshot().redacted] })
  return entry
}

function mapAudit(row: typeof schema.auditLog.$inferSelect): AuditEntry {
  return AuditEntry.rehydrate(row, new UniqueEntityID(row.id))
}

function cursorAfter(
  createdAt: AnyPgColumn<{ data: Date }>,
  id: AnyPgColumn<{ data: string }>,
  params: PaginationParams,
) {
  if (!params.cursor) return undefined
  const bytes = Buffer.from(params.cursor, 'base64url')
  if (bytes.toString('base64url') !== params.cursor) throw new Error('Invalid pagination cursor')
  const cursor = cursorPayloadSchema.parse(JSON.parse(bytes.toString('utf8')))
  return sql`(${createdAt}, ${id}) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
}

async function page<R extends { id: string; createdAt: Date }, T>(
  rows: R[],
  params: PaginationParams,
  map: (row: R) => T | Promise<T>,
): Promise<Page<T>> {
  const limit = boundedLimit(params.limit)
  const hasMore = rows.length > limit
  const selected = rows.slice(0, limit)
  const last = selected.at(-1)
  return {
    items: await Promise.all(selected.map(map)),
    hasMore,
    ...(hasMore && last
      ? {
          nextCursor: Buffer.from(
            JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.id }),
          ).toString('base64url'),
        }
      : {}),
  }
}
