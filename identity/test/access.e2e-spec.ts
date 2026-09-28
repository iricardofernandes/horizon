import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import postgres from 'postgres'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { base32Decode, hotp, stepAt } from '@/domain/mfa/totp'
import type { MemoryMailer } from '@/infrastructure/mail/smtp-mailer'
import { AppModule } from '@/main/app.module'
import { readEnvironment } from '@/main/environment'
import { IdentityRuntime } from '@/main/identity-runtime'

/**
 * Phase 67 over HTTP against PostgreSQL and Redis: a second factor at sign-in, lockout,
 * recovery codes used once, step-up, sessions whose revocation kills their tokens,
 * invitations, and the workspace MFA policy.
 */
let app: INestApplication
let runtime: IdentityRuntime
let directory: string
let administrator: ReturnType<typeof postgres>
const password = 'correct-horse-battery-staple'
const http = () => request(app.getHttpServer())

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'horizon-identity-access-'))
  await mkdir(join(directory, 'public'))
  const pair = generateKeyPairSync('ed25519')
  const privatePath = join(directory, 'private.pem')
  const keyPath = join(directory, 'blind-index.key')
  await Promise.all([
    writeFile(privatePath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), {
      mode: 0o600,
    }),
    writeFile(
      join(directory, 'public', 'ed25519-access-test-public.pem'),
      pair.publicKey.export({ type: 'spki', format: 'pem' }),
    ),
    writeFile(keyPath, randomBytes(32).toString('hex'), { mode: 0o600 }),
  ])
  const config = readEnvironment({
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    JWT_PRIVATE_KEY_PATH: privatePath,
    JWT_PUBLIC_KEYS_DIR: join(directory, 'public'),
    JWT_ACTIVE_KID: 'access-test',
    BLIND_INDEX_KEY_PATH: keyPath,
  })
  const module = await Test.createTestingModule({ imports: [AppModule.register(config)] }).compile()
  app = module.createNestApplication({ logger: false })
  await app.init()
  runtime = app.get(IdentityRuntime)
  administrator = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
})

afterAll(async () => {
  await Promise.allSettled([app?.close(), administrator?.end()])
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function workspace() {
  const slug = `access-${randomBytes(5).toString('hex')}`
  const email = `owner-${slug}@example.test`
  const created = await http()
    .post('/auth/signup')
    .send({
      name: 'Access Tenant',
      slug,
      timezone: 'UTC',
      owner: { name: 'Owner', email, password },
    })
    .expect(201)
  return { slug, email, tenantId: String(created.body.tenantId) }
}

/** Password, then a code when asked, then the workspace. */
async function signIn(slug: string, email: string, code?: () => { method: string; code: string }) {
  const first = await http().post('/auth/login').send({ email, password }).expect(200)
  let selection = first.body
  if (first.body.mfaRequired) {
    const answer = code?.()
    if (!answer) return { mfaRequired: true, challengeToken: String(first.body.challengeToken) }
    selection = (
      await http()
        .post('/auth/mfa')
        .send({ challengeToken: first.body.challengeToken, ...answer })
        .expect(200)
    ).body
  }
  const tenant = selection.workspaces.find((candidate: { slug: string }) => candidate.slug === slug)
  const chosen = await http()
    .post('/auth/workspace')
    .set('User-Agent', 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 Safari/537.36')
    .send({ selectionToken: selection.selectionToken, tenantId: tenant.tenantId })
  return { status: chosen.status, body: chosen.body }
}

async function enrollTotp(token: string) {
  const started = await http()
    .post('/me/mfa/totp')
    .set('Authorization', `Bearer ${token}`)
    .expect(200)
  const secret = String(started.body.secret)
  expect(started.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//)
  const confirmed = await http()
    .post(`/me/mfa/totp/${started.body.factorId}/confirm`)
    .set('Authorization', `Bearer ${token}`)
    .send({ code: hotp(base32Decode(secret), stepAt(new Date())) })
    .expect(200)
  return { secret, recoveryCodes: confirmed.body.recoveryCodes as string[] }
}

/** A code for a step not yet used: the next one, so nothing waits for the clock. */
const codeFor = (secret: string, offset: number) =>
  hotp(base32Decode(secret), stepAt(new Date()) + offset)

describe('a second factor at sign-in', () => {
  it('asks for it after the password, locks after five wrong codes, and spends recovery codes once', async () => {
    const { slug, email } = await workspace()
    const owner = await signIn(slug, email)
    const { secret, recoveryCodes } = await enrollTotp(owner.body.accessToken)
    expect(recoveryCodes).toHaveLength(10)

    const asked = await signIn(slug, email)
    expect(asked).toMatchObject({ mfaRequired: true })
    const withCode = await signIn(slug, email, () => ({ method: 'totp', code: codeFor(secret, 1) }))
    expect(withCode.status).toBe(200)

    const recovery = recoveryCodes[0] ?? ''
    expect((await signIn(slug, email, () => ({ method: 'recovery', code: recovery }))).status).toBe(
      200,
    )
    const replay = await http().post('/auth/login').send({ email, password }).expect(200)
    const replayed = await http()
      .post('/auth/mfa')
      .send({ challengeToken: replay.body.challengeToken, method: 'recovery', code: recovery })
    expect(replayed.status).toBe(401)

    const brute = await http().post('/auth/login').send({ email, password }).expect(200)
    const statuses: number[] = []
    for (let attempt = 0; attempt < 5; attempt += 1)
      statuses.push(
        (
          await http()
            .post('/auth/mfa')
            .send({ challengeToken: brute.body.challengeToken, method: 'totp', code: '000000' })
        ).status,
      )
    const right = await http()
      .post('/auth/mfa')
      .send({ challengeToken: brute.body.challengeToken, method: 'totp', code: codeFor(secret, 0) })
    // The replayed recovery code above was the first wrong answer of this window.
    expect(statuses).toEqual([401, 401, 401, 429, 429])
    expect(right.status).toBe(429)
    expect(JSON.stringify(right.body)).not.toContain(secret)
  })
})

describe('step-up and sessions', () => {
  it('asks a stale token to step up, and a revoked session loses its live tokens', async () => {
    const { slug, email, tenantId } = await workspace()
    const first = await signIn(slug, email)
    const second = await signIn(slug, email)
    const token = String(first.body.accessToken)

    const listed = await http()
      .get('/auth/sessions')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(listed.body.data).toHaveLength(2)
    expect(listed.body.data.find((session: { current: boolean }) => session.current)).toMatchObject(
      {
        device: 'Chrome on Linux',
      },
    )

    const [userRow] = await administrator`select id from users where tenant_id = ${tenantId}`
    const stale = await runtime.signer.mint(
      { subject: String(userRow?.id), tenantId, roles: [{ module: 'identity', role: 'owner' }] },
      new Date(),
      {
        sid: String(first.body.familyId),
        amr: ['pwd'],
        authTime: new Date(Date.now() - 20 * 60_000),
      },
    )
    const refused = await http()
      .post('/api-keys')
      .set('Authorization', `Bearer ${stale.token}`)
      .send({ name: 'ci', scopes: ['identity:read'] })
    expect(refused.status).toBe(403)
    expect(refused.body.type).toBe('https://horizon.dev/problems/step-up-required')
    const stepped = await http()
      .post('/auth/step-up')
      .set('Authorization', `Bearer ${stale.token}`)
      .send({ password })
      .expect(200)
    await http()
      .post('/api-keys')
      .set('Authorization', `Bearer ${stepped.body.accessToken}`)
      .send({ name: 'ci', scopes: ['identity:read'] })
      .expect(201)

    await http()
      .delete(`/auth/sessions/${second.body.familyId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    await http().get('/me').set('Authorization', `Bearer ${second.body.accessToken}`).expect(401)
    await http().get('/me').set('Authorization', `Bearer ${token}`).expect(200)
    const others = await http()
      .post('/auth/sessions/revoke-others')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(others.body.ended).toBe(0)
    const audit =
      await administrator`select action from audit_log where tenant_id = ${tenantId} order by sequence`
    expect(audit.map((row) => row.action)).toEqual(
      expect.arrayContaining(['session.stepped-up', 'session.revoked', 'api-key.created']),
    )
  })
})

describe('invitations and the MFA policy', () => {
  it('invites, accepts once, refuses expired links, and enforces the policy after its grace', async () => {
    const { slug, email, tenantId } = await workspace()
    const owner = await signIn(slug, email)
    const token = String(owner.body.accessToken)
    const guestEmail = `guest-${randomBytes(4).toString('hex')}@example.test`
    const invited = await http()
      .post('/invitations')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: guestEmail, name: 'Guest', roles: [{ module: 'catalog', role: 'viewer' }] })
      .expect(201)
    expect(invited.body.email).toMatch(/^g\*\*\*@/)
    const mailer = runtime.mailer as MemoryMailer
    const link = mailer.sent.at(-1)?.text ?? ''
    const invitationToken = /token=([A-Za-z0-9_-]+)/.exec(link)?.[1] ?? ''
    expect(
      (await http().get(`/invitations/lookup?token=${invitationToken}`).expect(200)).body,
    ).toMatchObject({
      workspace: 'Access Tenant',
      hasAccount: false,
    })
    await http()
      .post('/invitations/accept')
      .send({ token: invitationToken, name: 'Guest', password })
      .expect(200)
    await http()
      .post('/invitations/accept')
      .send({ token: invitationToken, name: 'Guest', password })
      .expect(410)
    const [stored] =
      await administrator`select email, status from invitations where id = ${invited.body.id}`
    expect(stored).toMatchObject({ email: null, status: 'accepted' })
    expect((await signIn(slug, guestEmail)).status).toBe(200)

    const late = await http()
      .post('/invitations')
      .set('Authorization', `Bearer ${token}`)
      .send({
        email: `late-${guestEmail}`,
        name: 'Late',
        roles: [{ module: 'catalog', role: 'viewer' }],
      })
      .expect(201)
    const lateToken = /token=([A-Za-z0-9_-]+)/.exec(mailer.sent.at(-1)?.text ?? '')?.[1] ?? ''
    await administrator`update invitations set expires_at = now() - interval '1 second' where id = ${late.body.id}`
    await http()
      .post('/invitations/accept')
      .send({ token: lateToken, name: 'Late', password })
      .expect(410)

    await http()
      .put('/workspace/mfa-policy')
      .set('Authorization', `Bearer ${token}`)
      .send({ policy: 'everyone', graceDays: 0 })
      .expect(200)
    const blocked = await signIn(slug, guestEmail)
    expect(blocked.status).toBe(403)
    expect(blocked.body.type).toBe('https://horizon.dev/problems/mfa-enrollment-required')
    const enrollmentToken = String(blocked.body.enrollmentToken)
    const started = await http().post('/auth/enrollment/totp').send({ enrollmentToken }).expect(200)
    const secret = String(started.body.secret)
    await http()
      .post('/auth/enrollment/totp/confirm')
      .send({ enrollmentToken, factorId: started.body.factorId, code: codeFor(secret, 0) })
      .expect(200)
    const through = await signIn(slug, guestEmail, () => ({
      method: 'totp',
      code: codeFor(secret, 1),
    }))
    expect(through.status).toBe(200)
    const [policy] = await administrator`select mfa_policy from tenants where id = ${tenantId}`
    expect(policy?.mfa_policy).toBe('everyone')
  })
})
