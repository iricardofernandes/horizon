import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cursorPayloadSchema } from '@horizon/contracts'
import postgres from 'postgres'
import { AuthenticateApiKeyUseCase } from '@/application/use-cases/authenticate-api-key'
import { AuthenticateUserUseCase } from '@/application/use-cases/authenticate-user'
import { CreateTenantUseCase } from '@/application/use-cases/create-tenant'
import { DescribeCompanyUseCase } from '@/application/use-cases/describe-company'
import { DisableUserUseCase } from '@/application/use-cases/disable-user'
import { RevokeApiKeyUseCase } from '@/application/use-cases/revoke-api-key'
import { VerifyAuditChainUseCase } from '@/application/use-cases/verify-audit-chain'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ApiKey } from '@/domain/entities/api-key'
import { ApiKeyScopes } from '@/domain/value-objects/api-key-scopes'
import { ApiKeyToken } from '@/domain/value-objects/api-key-token'
import { AesGcmSecretBox } from '@/infrastructure/cryptography/aes-gcm-secret-box'
import { IdentityDatabase } from '@/infrastructure/database/drizzle/identity-database'
import { makeApiKey } from './factories/make-api-key'
import { identityContext } from './support/identity-context'

let db: IdentityDatabase
let raw: ReturnType<typeof postgres>
let owner: ReturnType<typeof postgres>
const hash = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA'

beforeAll(() => {
  db = new IdentityDatabase({
    url: process.env.DATABASE_URL ?? '',
    secretBox: new AesGcmSecretBox(),
    blindIndexKey: randomBytes(32),
    poolMax: 2,
  })
  raw = postgres(process.env.DATABASE_URL ?? '', { max: 1 })
  owner = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
})
afterAll(async () => {
  await Promise.allSettled([db?.close(), raw?.end(), owner?.end()])
})

async function tenant() {
  const slug = `tenant-${randomBytes(6).toString('hex')}`
  const result = await new CreateTenantUseCase(
    db,
    db.directory,
    { hash: async () => hash, verify: async () => true, verifyDummy: async () => undefined },
    {
      token: () => '',
      alphanumeric: () => '',
      identifier: () => new UniqueEntityID().toString(),
      keyMaterial: () => randomBytes(32).toString('base64'),
    },
    { now: () => new Date() },
  ).execute({
    name: 'Test tenant',
    slug,
    timezone: 'UTC',
    owner: { name: 'Owner Person', email: 'owner@example.com', password: 'example-test-password' },
  })
  if (result.isLeft()) throw result.value
  return { ...result.value, slug }
}

it('persists sign-up, encrypts personal data and atomically records events', async () => {
  const created = await tenant()
  expect(await db.directory.resolve(created.slug)).toBe(created.tenantId)
  await db.inTenant(created.tenantId, async (scope) => {
    const user = await scope.users.findById(created.ownerId)
    expect(user?.toSnapshot().email).toBe('owner@example.com')
    expect(await scope.audit.lastSequence()).toBe(1)
  })
  const [row] = await owner`select * from users where id = ${created.ownerId}`
  expect(row?.email_ciphertext).not.toContain('owner@example.com')
  const events = await owner`select * from outbox where tenant_id = ${created.tenantId}`
  expect(events.map((event) => event.event_type).sort()).toEqual([
    'identity.tenant.created',
    'identity.user.registered',
  ])
})

it('round-trips an alphanumeric issuer CNPJ and municipality code through the expanded tenant row', async () => {
  const created = await tenant()
  const result = await new DescribeCompanyUseCase(db, { now: () => new Date() }).execute({
    tenantId: created.tenantId,
    actor: { type: 'user', id: created.ownerId },
    company: {
      legalName: 'Issuer LTDA',
      taxId: '00.000.000/e08g-12',
      addressMunicipalityCode: '3550308',
      baseCurrency: 'BRL',
      fiscalRegime: 'simples-nacional',
    },
    timezone: 'America/Sao_Paulo',
    fiscalEffectiveFrom: '2026-09-01',
  })
  if (result.isLeft()) throw result.value
  const restored = await db.inTenant(created.tenantId, (scope) =>
    scope.tenants.findById(created.tenantId),
  )
  expect(restored?.toSnapshot().company).toMatchObject({
    taxId: '00000000E08G12',
    address: { municipalityCode: '3550308' },
  })
  const exportRecord = await db.findCompanyFiscalExport(created.tenantId, 1)
  expect(exportRecord).toMatchObject({
    effectiveFrom: '2026-09-01',
    company: { taxId: '00000000E08G12', address: { municipalityCode: '3550308' } },
  })
  const [history] =
    await owner`select ciphertext from company_profile_versions where tenant_id = ${created.tenantId}`
  expect(JSON.stringify(history)).not.toContain('E08G')
  const notices =
    await owner`select event_type,payload from outbox where tenant_id = ${created.tenantId}`
  expect(
    notices.find((event) => event.event_type === 'identity.company.fiscal-profile-changed')
      ?.payload,
  ).toMatchObject({ tenantId: created.tenantId, revision: 1, effectiveFrom: '2026-09-01' })
})

it('enforces RLS on tenants, users, API keys, subject keys, audit and outbox', async () => {
  const a = await tenant()
  const b = await tenant()
  const scopes = ApiKeyScopes.create(['identity:read'])
  if (scopes.isLeft()) throw scopes.value
  const key = ApiKey.create({
    tenantId: a.tenantId,
    issuedBy: a.ownerId,
    name: 'test',
    environment: 'test',
    prefix: randomBytes(12).toString('hex'),
    secretHash: hash,
    scopes: scopes.value,
  })
  await db.inTenant(a.tenantId, (scope) => scope.apiKeys.create(key))
  await db.inTenant(b.tenantId, async (scope) => {
    expect(await scope.tenants.findById(a.tenantId)).toBeNull()
    expect(await scope.users.findById(a.ownerId)).toBeNull()
    expect(await scope.apiKeys.findById(key.id.toString())).toBeNull()
    expect(await scope.dataSubjectKeys.findBySubject(a.ownerId)).toBeNull()
    expect(
      (await scope.audit.walk(0, 100)).every((entry) => entry.toSnapshot().tenantId === b.tenantId),
    ).toBe(true)
  })
  await raw.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${b.tenantId}, true)`
    expect(await tx`select * from outbox where tenant_id = ${a.tenantId}`).toHaveLength(0)
  })
  await expect(
    raw.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${b.tenantId}, true)`
      await tx`insert into inbox(source_module,event_id,event_type,tenant_id) values ('sales',${new UniqueEntityID().toString()},'sales.order.created',${a.tenantId})`
    }),
  ).rejects.toThrow('row-level security')
})

it('cannot bypass RLS, use the migration role, or carry tenant context across pool reuse', async () => {
  const a = await tenant()
  const roles = await raw`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`
  expect(roles[0]).toMatchObject({ rolsuper: false, rolbypassrls: false })
  await expect(raw`set role horizon_owner`).rejects.toThrow()
  await expect(raw`select * from users`).rejects.toThrow()
  await raw.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${a.tenantId}, true)`
    expect(await tx`select * from users`).toHaveLength(1)
  })
  await expect(raw`select * from users`).rejects.toThrow()
  await expect(
    raw.begin(async (tx) => {
      await tx`set local row_security = off`
      await tx`select * from users`
    }),
  ).rejects.toThrow()
  expect(Object.keys(db).sort()).toEqual(['accounts', 'directory'])
})

it('rolls back state, directory entries, audit and outbox on a failed transaction', async () => {
  const a = await tenant()
  await expect(
    db.inTenant(a.tenantId, async (scope) => {
      const user = await scope.users.findById(a.ownerId)
      if (!user) throw new Error('Missing user')
      user.disable(new Date())
      await scope.users.save(user)
      await scope.audit.append({
        actor: { type: 'system', id: null },
        subjectType: 'user',
        subjectId: a.ownerId,
        action: 'user.disabled',
        occurredAt: new Date(),
      })
      throw new Error('abort')
    }),
  ).rejects.toThrow('abort')
  await db.inTenant(a.tenantId, async (scope) => {
    expect((await scope.users.findById(a.ownerId))?.canAuthenticate()).toBe(true)
    expect(await scope.audit.lastSequence()).toBe(1)
  })
  expect(await owner`select * from outbox where tenant_id = ${a.tenantId}`).toHaveLength(2)
})

it('serializes concurrent audit appends and detects tampering at the first broken link', async () => {
  const a = await tenant()
  await Promise.all(
    Array.from({ length: 8 }, () =>
      db.inTenant(a.tenantId, (scope) =>
        scope.audit.append({
          actor: { type: 'system', id: null },
          subjectType: 'tenant',
          subjectId: a.tenantId,
          action: 'tenant.checked',
          occurredAt: new Date(),
        }),
      ),
    ),
  )
  const verifier = new VerifyAuditChainUseCase(db)
  expect((await verifier.execute({ tenantId: a.tenantId, batchSize: 2 })).value).toMatchObject({
    intact: true,
    verifiedThrough: 9,
  })
  await owner.begin(async (tx) => {
    await tx`alter table audit_log disable trigger audit_append_only`
    await tx`update audit_log set action = 'forged' where tenant_id = ${a.tenantId} and sequence = 3`
    await tx`alter table audit_log enable trigger audit_append_only`
  })
  expect((await verifier.execute({ tenantId: a.tenantId })).value).toMatchObject({
    intact: false,
    verifiedThrough: 2,
    brokenAt: 3,
  })
  const cli = await runAuditCli(a.tenantId)
  expect(cli.stderr).toBe('')
  expect(cli.code).toBe(1)
  expect(JSON.parse(cli.stdout)).toMatchObject({ intact: false, verifiedThrough: 2, brokenAt: 3 })
})

async function runAuditCli(
  tenantId: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'identity-audit-test-'))
  const keyPath = join(directory, 'blind-index.key')
  try {
    await writeFile(keyPath, randomBytes(32).toString('hex'), { mode: 0o600 })
    return await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['-r', '@swc-node/register', 'src/infrastructure/cli/verify-audit.ts', tenantId],
        {
          env: { ...process.env, BLIND_INDEX_KEY_PATH: keyPath },
          timeout: 10000,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString()
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
      })
      child.on('error', reject)
      child.on('close', (code) => resolve({ code, stdout, stderr }))
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

it('destroys the subject key while preserving ciphertext and audit verification', async () => {
  const a = await tenant()
  await db.inTenant(a.tenantId, (scope) =>
    scope.audit.append({
      actor: { type: 'system', id: null },
      subjectType: 'user',
      subjectId: a.ownerId,
      action: 'user.updated',
      dataSubjectId: a.ownerId,
      after: { name: 'Personal Name', password: 'redact-me' },
      occurredAt: new Date(),
    }),
  )
  const [before] =
    await owner`select email_ciphertext, name_ciphertext from users where id = ${a.ownerId}`
  const [credentialsBefore] =
    await owner`select email_index, password_hash from users where id = ${a.ownerId}`
  await db.inTenant(a.tenantId, async (scope) => {
    const user = await scope.users.findById(a.ownerId)
    const key = await scope.dataSubjectKeys.findBySubject(a.ownerId)
    if (!user || !key) throw new Error('Missing fixture')
    key.destroy(new Date())
    user.markErased(new Date())
    await scope.dataSubjectKeys.save(key)
    await scope.users.save(user)
    await scope.outbox.publish(key.pullDomainEvents())
  })
  const [after] =
    await owner`select email_ciphertext, name_ciphertext from users where id = ${a.ownerId}`
  expect(after).toEqual(before)
  const [credentialsAfter] =
    await owner`select email_index, password_hash from users where id = ${a.ownerId}`
  expect(credentialsAfter?.email_index).toBe(`erased:${a.ownerId}`)
  expect(credentialsAfter?.password_hash).not.toBe(credentialsBefore?.password_hash)
  await db.inTenant(a.tenantId, async (scope) => {
    expect((await scope.dataSubjectKeys.findBySubject(a.ownerId))?.material()).toBeNull()
    expect((await scope.users.findById(a.ownerId))?.toSnapshot().email).toBe(
      'erased@invalid.example',
    )
    const audit = (await scope.audit.walk(1, 1))[0]?.toSnapshot()
    expect(JSON.stringify(audit?.after)).not.toContain('Personal Name')
    expect(audit?.redacted).toContain('password')
  })
  expect(
    (await new VerifyAuditChainUseCase(db).execute({ tenantId: a.tenantId })).value,
  ).toMatchObject({ intact: true, verifiedThrough: 2 })
})

it('rejects audit modification even if a mistaken grant restores mutation privileges', async () => {
  const a = await tenant()
  await expect(
    raw.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${a.tenantId}, true)`
      await tx`update audit_log set action = 'forged'`
    }),
  ).rejects.toThrow()
  await expect(owner`delete from audit_log where tenant_id = ${a.tenantId}`).rejects.toThrow(
    'append-only',
  )
  await expect(owner`truncate audit_log`).rejects.toThrow('append-only')
})

it('removes broad default privileges and runs migrations under an unprivileged owner', async () => {
  const migration = postgres(process.env.DATABASE_MIGRATION_URL ?? '')
  try {
    const [role] =
      await migration`select rolsuper, rolcreaterole, rolbypassrls from pg_roles where rolname = current_user`
    expect(role).toMatchObject({ rolsuper: false, rolcreaterole: false, rolbypassrls: false })
  } finally {
    await migration.end()
  }
  const [privileges] = await raw`select
    has_table_privilege(current_user, 'audit_log', 'UPDATE') as audit_update,
    has_table_privilege(current_user, 'audit_log', 'DELETE') as audit_delete,
    has_table_privilege(current_user, 'outbox', 'UPDATE') as outbox_update,
    has_table_privilege(current_user, 'users', 'DELETE') as users_delete`
  expect(privileges).toEqual({
    audit_update: false,
    audit_delete: false,
    outbox_update: false,
    users_delete: false,
  })
})

it('requires an existing tenant and rejects API keys issued by another tenant', async () => {
  const a = await tenant()
  const b = await tenant()
  const absent = new UniqueEntityID().toString()
  await expect(
    db.inTenant(absent, () => db.directory.register(`missing-${absent}`, absent)),
  ).rejects.toThrow()
  await expect(
    db.inTenant(absent, (scope) =>
      scope.audit.append({
        actor: { type: 'system', id: null },
        subjectType: 'tenant',
        subjectId: absent,
        action: 'tenant.checked',
        occurredAt: new Date(),
      }),
    ),
  ).rejects.toThrow('Audit tenant does not exist')
  await expect(
    db.inTenant(a.tenantId, (scope) =>
      scope.apiKeys.create(makeApiKey({ tenantId: a.tenantId, issuedBy: b.ownerId })),
    ),
  ).rejects.toThrow()
  expect(await owner`select * from api_keys where tenant_id = ${a.tenantId}`).toHaveLength(0)
  await expect(
    db.inTenant(a.tenantId, (scope) =>
      scope.apiKeys.create(makeApiKey({ tenantId: b.tenantId, issuedBy: b.ownerId })),
    ),
  ).rejects.toThrow('Aggregate tenant')
  await expect(
    raw.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${a.tenantId}, true)`
      await tx`insert into users(id,tenant_id,email_ciphertext,email_index,name_ciphertext,password_hash,created_at,updated_at)
      values (${new UniqueEntityID().toString()},${a.tenantId},'encrypted','index','encrypted',${hash},now(),now())`
    }),
  ).rejects.toThrow('users_tenant_subject_key_fk')
})

it('returns contract-compatible cursors and paginates by creation time with a stable id tiebreaker', async () => {
  const a = await tenant()
  const first = makeApiKey({
    tenantId: a.tenantId,
    issuedBy: a.ownerId,
    prefix: randomBytes(12).toString('hex'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
  })
  const second = makeApiKey({
    tenantId: a.tenantId,
    issuedBy: a.ownerId,
    prefix: randomBytes(12).toString('hex'),
    createdAt: new Date('2025-01-01T00:00:00Z'),
  })
  const tied = makeApiKey({
    tenantId: a.tenantId,
    issuedBy: a.ownerId,
    prefix: randomBytes(12).toString('hex'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
  })
  await db.inTenant(a.tenantId, async (scope) => {
    for (const key of [first, second, tied]) await scope.apiKeys.create(key)
    const page = await scope.apiKeys.list({ limit: 1 })
    expect(page.items[0]?.id.toString()).toBe(second.id.toString())
    if (!page.nextCursor) throw new Error('Missing cursor')
    expect(
      cursorPayloadSchema.parse(
        JSON.parse(Buffer.from(page.nextCursor, 'base64url').toString('utf8')),
      ),
    ).toEqual({ createdAt: '2025-01-01T00:00:00.000Z', id: second.id.toString() })
    const next = await scope.apiKeys.list({ limit: 1, cursor: page.nextCursor })
    expect(next.items[0]?.id.toString()).toBe(first.id.toString())
    if (!next.nextCursor) throw new Error('Missing cursor')
    const last = await scope.apiKeys.list({ limit: 1, cursor: next.nextCursor })
    expect(last.items[0]?.id.toString()).toBe(tied.id.toString())
    expect(last.hasMore).toBe(false)
  })
})

function gate() {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function expectBlockedDatabaseWrite() {
  await expect
    .poll(
      async () => {
        const [row] =
          await owner`select count(*)::int as count from pg_stat_activity where datname = current_database() and usename = 'horizon_app' and wait_event_type = 'Lock'`
        return row?.count ?? 0
      },
      { timeout: 3000 },
    )
    .toBeGreaterThan(0)
}

it('serializes login with concurrent disable so a stale login cannot reactivate the account', async () => {
  const a = await tenant()
  const c = await identityContext()
  const verifying = gate()
  const release = gate()
  c.hasher.verify.mockImplementation(async () => {
    verifying.resolve()
    await release.promise
    return true
  })
  const login = new AuthenticateUserUseCase(
    db,
    db.directory,
    c.hasher,
    c.sessions,
    c.policy,
    c.clock,
  )
  const disable = new DisableUserUseCase(db, c.families, c.denylist, c.policy, c.clock)
  const opened = login.execute({
    tenantSlug: a.slug,
    email: 'owner@example.com',
    password: 'correct',
  })
  await verifying.promise
  const disabled = disable.execute({ tenantId: a.tenantId, userId: a.ownerId, actor: c.actor })
  try {
    await expectBlockedDatabaseWrite()
  } finally {
    release.resolve()
  }
  expect((await opened).isRight()).toBe(true)
  expect((await disabled).isRight()).toBe(true)
  await db.inTenant(a.tenantId, async (scope) =>
    expect((await scope.users.findById(a.ownerId))?.canAuthenticate()).toBe(false),
  )
  expect(await c.families.findAllForUser(a.tenantId, a.ownerId)).toEqual([])
})

it('serializes API-key authentication with revocation so last-used cannot restore a revoked key', async () => {
  const a = await tenant()
  const key = makeApiKey({
    tenantId: a.tenantId,
    issuedBy: a.ownerId,
    prefix: randomBytes(12).toString('hex'),
  })
  await db.inTenant(a.tenantId, (scope) => scope.apiKeys.create(key))
  const c = await identityContext()
  const verifying = gate()
  const release = gate()
  c.hasher.verify.mockImplementation(async () => {
    verifying.resolve()
    await release.promise
    return true
  })
  const authenticate = new AuthenticateApiKeyUseCase(db, c.hasher, c.clock)
  const revoke = new RevokeApiKeyUseCase(db, c.clock)
  const authenticated = authenticate.execute({
    tenantId: a.tenantId,
    presented: `hz_test_${key.toSnapshot().prefix}_${'B'.repeat(32)}`,
  })
  await verifying.promise
  const revoked = revoke.execute({
    tenantId: a.tenantId,
    apiKeyId: key.id.toString(),
    actor: c.actor,
  })
  try {
    await expectBlockedDatabaseWrite()
  } finally {
    release.resolve()
  }
  expect((await authenticated).isRight()).toBe(true)
  expect((await revoked).isRight()).toBe(true)
  await db.inTenant(a.tenantId, async (scope) =>
    expect((await scope.apiKeys.findById(key.id.toString()))?.isUsableAt(c.clock.now())).toBe(
      false,
    ),
  )
})

it('serializes rotation with revoke so saving the outgoing key cannot undo revocation', async () => {
  const a = await tenant()
  const key = makeApiKey({
    tenantId: a.tenantId,
    issuedBy: a.ownerId,
    prefix: randomBytes(12).toString('hex'),
  })
  await db.inTenant(a.tenantId, (scope) => scope.apiKeys.create(key))
  const read = gate()
  const release = gate()
  const now = new Date()
  const rotating = db.inTenant(a.tenantId, async (scope) => {
    const outgoing = await scope.apiKeys.findById(key.id.toString())
    if (!outgoing) throw new Error('Missing API key')
    read.resolve()
    await release.promise
    const result = outgoing.rotate({
      token: ApiKeyToken.create({
        environment: 'test',
        prefix: randomBytes(12).toString('hex'),
        secret: 'B'.repeat(32),
      }),
      secretHash: hash,
      now,
      until: new Date(now.getTime() + 30000),
    })
    if (result.isLeft()) throw result.value
    await scope.apiKeys.save(outgoing)
    await scope.apiKeys.create(result.value)
    return result.value.id.toString()
  })
  await read.promise
  const revoking = new RevokeApiKeyUseCase(db, { now: () => now }).execute({
    tenantId: a.tenantId,
    apiKeyId: key.id.toString(),
    actor: { type: 'system', id: null },
  })
  try {
    await expectBlockedDatabaseWrite()
  } finally {
    release.resolve()
  }
  const replacementId = await rotating
  expect((await revoking).isRight()).toBe(true)
  await db.inTenant(a.tenantId, async (scope) => {
    expect((await scope.apiKeys.findById(key.id.toString()))?.isUsableAt(now)).toBe(false)
    expect((await scope.apiKeys.findById(replacementId))?.isUsableAt(now)).toBe(true)
  })
})

it('processes a concurrent duplicate event once with inbox, effect and outbox in one transaction', async () => {
  const a = await tenant()
  const event = {
    sourceModule: 'sales',
    eventId: new UniqueEntityID().toString(),
    eventType: 'sales.order.created',
  }
  const started = gate()
  const release = gate()
  let effects = 0
  const work = async (scope: Parameters<Parameters<IdentityDatabase['inTenant']>[1]>[0]) => {
    effects++
    started.resolve()
    await release.promise
    const user = await scope.users.findById(a.ownerId)
    if (!user) throw new Error('Missing user')
    user.disable(new Date())
    await scope.users.save(user)
    return 'handled'
  }
  const first = db.processEvent(a.tenantId, event, work)
  await started.promise
  const duplicate = db.processEvent(a.tenantId, event, work)
  try {
    await expectBlockedDatabaseWrite()
  } finally {
    release.resolve()
  }
  expect(await first).toEqual({ processed: true, value: 'handled' })
  expect(await duplicate).toEqual({ processed: false })
  expect(effects).toBe(1)
  expect(await owner`select * from inbox where event_id = ${event.eventId}`).toHaveLength(1)
  expect(
    await owner`select * from outbox where tenant_id = ${a.tenantId} and event_type = 'identity.user.disabled'`,
  ).toHaveLength(1)
})

it('rolls back the inbox claim and effect together so a failed delivery can retry', async () => {
  const a = await tenant()
  const event = {
    sourceModule: 'sales',
    eventId: new UniqueEntityID().toString(),
    eventType: 'sales.order.created',
  }
  await expect(
    db.processEvent(a.tenantId, event, async (scope) => {
      const user = await scope.users.findById(a.ownerId)
      if (!user) throw new Error('Missing user')
      user.disable(new Date())
      await scope.users.save(user)
      throw new Error('effect failed')
    }),
  ).rejects.toThrow('effect failed')
  expect(await owner`select * from inbox where event_id = ${event.eventId}`).toHaveLength(0)
  await db.inTenant(a.tenantId, async (scope) =>
    expect((await scope.users.findById(a.ownerId))?.canAuthenticate()).toBe(true),
  )
  expect(
    await owner`select * from outbox where tenant_id = ${a.tenantId} and event_type = 'identity.user.disabled'`,
  ).toHaveLength(0)
  expect(await db.processEvent(a.tenantId, event, async () => 'retried')).toEqual({
    processed: true,
    value: 'retried',
  })
})
