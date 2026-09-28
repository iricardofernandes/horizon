#!/usr/bin/env node
/**
 * Phase 67 security drill, against the local stack through Kong (ADR 0061). It proves:
 *   1. brute force on TOTP locks the second factor out;
 *   2. a replayed recovery code is refused;
 *   3. a revoked session's access token is refused within its lifetime, by Identity and by
 *      Catalog;
 *   4. an expired or used invitation is refused.
 * It stores its results in docs/drills/, and exits non-zero if any check failed.
 *
 *   node scripts/phase67-drill.mjs [--base-url http://localhost:8000] [--mailpit http://localhost:8025]
 */
import { execFileSync } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const baseUrl = flag('base-url', 'http://localhost:8000').replace(/\/$/, '')
const mailpit = flag('mailpit', 'http://localhost:8025').replace(/\/$/, '')
const password = `Drill-${randomBytes(9).toString('base64url')}`
const startedAt = new Date()
const checks = []

async function call(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      'user-agent': 'phase67-drill',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  let parsed = text
  try {
    parsed = JSON.parse(text)
  } catch {}
  return { status: response.status, body: parsed }
}

async function ok(path, options) {
  const answer = await call(path, options)
  if (answer.status >= 400) throw new Error(`${options?.method ?? 'GET'} ${path}: ${answer.status} ${JSON.stringify(answer.body)}`)
  return answer.body
}

function check(name, passed, evidence) {
  checks.push({ name, passed, evidence })
  console.log(`${passed ? '✓' : '✗'} ${name}`, JSON.stringify(evidence))
}

// RFC 6238, as Identity computes it.
function base32(text) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  const bytes = []
  for (const character of text.replace(/=+$/, '')) {
    value = (value << 5) | alphabet.indexOf(character)
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}
function totp(secret, offset = 0) {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offset))
  const digest = createHmac('sha1', base32(secret)).update(counter).digest()
  const at = digest[digest.length - 1] & 15
  const binary = ((digest[at] & 127) << 24) | (digest[at + 1] << 16) | (digest[at + 2] << 8) | digest[at + 3]
  return String(binary % 1_000_000).padStart(6, '0')
}

async function workspace(label) {
  const slug = `drill-${label}-${randomBytes(4).toString('hex')}`
  const email = `owner-${slug}@drill.example`
  await ok('/auth/signup', {
    method: 'POST',
    body: { name: `Drill ${label}`, slug, timezone: 'America/Sao_Paulo', owner: { name: 'Drill Owner', email, password } },
  })
  return { slug, email }
}

/** Password, the second factor when asked, then the workspace. */
async function signIn({ slug, email }, secondFactor) {
  const first = await ok('/auth/login', { method: 'POST', body: { email, password } })
  let selection = first
  if (first.mfaRequired) {
    if (!secondFactor) return { challenge: first.challengeToken }
    const answer = await call('/auth/mfa', { method: 'POST', body: { challengeToken: first.challengeToken, ...secondFactor } })
    if (answer.status !== 200) return { refused: answer.status }
    selection = answer.body
  }
  const tenant = selection.workspaces.find((candidate) => candidate.slug === slug)
  return ok('/auth/workspace', { method: 'POST', body: { selectionToken: selection.selectionToken, tenantId: tenant.tenantId } })
}

async function enroll(token) {
  const started = await ok('/identity/me/mfa/totp', { method: 'POST', token })
  const confirmed = await ok(`/identity/me/mfa/totp/${started.factorId}/confirm`, {
    method: 'POST',
    token,
    body: { code: totp(started.secret) },
  })
  return { secret: started.secret, recoveryCodes: confirmed.recoveryCodes }
}

// --- 2. a replayed recovery code, then 1. brute force on TOTP ----------------------------
const mfa = await workspace('mfa')
const owner = await signIn(mfa)
const { secret, recoveryCodes } = await enroll(owner.accessToken)
const recovery = recoveryCodes[0]
const firstUse = await signIn(mfa, { method: 'recovery', code: recovery })
const replay = await signIn(mfa, { method: 'recovery', code: recovery })
check('a replayed recovery code is refused', Boolean(firstUse.accessToken) && replay.refused === 401, {
  firstUse: firstUse.accessToken ? 200 : firstUse.refused,
  replay: replay.refused,
})

const brute = await signIn(mfa)
const statuses = []
for (let attempt = 0; attempt < 6; attempt += 1)
  statuses.push((await call('/auth/mfa', { method: 'POST', body: { challengeToken: brute.challenge, method: 'totp', code: String(100000 + attempt) } })).status)
const rightCode = await call('/auth/mfa', { method: 'POST', body: { challengeToken: brute.challenge, method: 'totp', code: totp(secret, 1) } })
check('brute force on TOTP locks out, even the right code', statuses.includes(429) && rightCode.status === 429, {
  wrongAttempts: statuses,
  rightCodeWhileLocked: rightCode.status,
  // The replayed recovery code above was the first wrong answer of this window.
  lockedAtAttempt: statuses.indexOf(429) + 1,
})

// --- 3. a revoked session's access token ----------------------------------------------------
const sessions = await workspace('sessions')
const keeper = await signIn(sessions)
const doomed = await signIn(sessions)
const beforeIdentity = (await call('/identity/me', { token: doomed.accessToken })).status
const beforeCatalog = (await call('/catalog/items', { token: doomed.accessToken })).status
await ok(`/identity/auth/sessions/${doomed.familyId}`, { method: 'DELETE', token: keeper.accessToken })
const afterIdentity = (await call('/identity/me', { token: doomed.accessToken })).status
const afterCatalog = (await call('/catalog/items', { token: doomed.accessToken })).status
const refresh = (await call('/auth/refresh', {
  method: 'POST',
  body: { tenantId: JSON.parse(Buffer.from(doomed.accessToken.split('.')[1], 'base64url')).tenant_id, familyId: doomed.familyId, refreshToken: doomed.refreshToken },
})).status
const secondsLeft = Math.round((new Date(doomed.accessTokenExpiresAt).getTime() - Date.now()) / 1000)
check(
  "a revoked session's access token is refused within its lifetime",
  beforeIdentity === 200 && afterIdentity === 401 && afterCatalog === 401 && refresh === 401 && secondsLeft > 0,
  { beforeIdentity, beforeCatalog, afterIdentity, afterCatalog, refresh, tokenSecondsLeft: secondsLeft },
)

// --- 4. an expired or used invitation ------------------------------------------------------
async function inviteAndRead(token, email) {
  const invitation = await ok('/identity/invitations', {
    method: 'POST',
    token,
    body: { email, name: 'Drill Guest', roles: [{ module: 'catalog', role: 'viewer' }] },
  })
  const listing = await (await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json()
  const message = await (await fetch(`${mailpit}/api/v1/message/${listing.messages[0].ID}`)).json()
  return { id: invitation.id, token: /token=([A-Za-z0-9_-]+)/.exec(message.Text)?.[1] }
}
const inviter = await signIn(sessions)
const guest = `guest-${randomBytes(4).toString('hex')}@drill.example`
const used = await inviteAndRead(inviter.accessToken, guest)
const accepted = (await call('/identity/invitations/accept', { method: 'POST', body: { token: used.token, name: 'Guest', password } })).status
const reused = (await call('/identity/invitations/accept', { method: 'POST', body: { token: used.token, name: 'Guest', password } })).status
const late = await inviteAndRead(inviter.accessToken, `late-${guest}`)
execFileSync('docker', [
  'exec', 'horizon-postgres', 'psql', '-U', 'postgres', '-d', 'horizon_identity', '-tAc',
  `update invitations set expires_at = now() - interval '1 second' where id = '${late.id}'`,
])
const expired = (await call('/identity/invitations/accept', { method: 'POST', body: { token: late.token, name: 'Late', password } })).status
const lookupExpired = (await call(`/identity/invitations/lookup?token=${late.token}`)).status
check('an expired or used invitation is refused', accepted === 200 && reused === 410 && expired === 410 && lookupExpired === 410, {
  firstAccept: accepted,
  secondAccept: reused,
  expiredAccept: expired,
  expiredLookup: lookupExpired,
  deliveredBy: 'mailpit',
})

// --- the record ------------------------------------------------------------------------------
const passed = checks.every((entry) => entry.passed)
const record = {
  drill: 'phase67-security',
  adr: '0061',
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  baseUrl,
  passed,
  checks,
}
const path = join(root, 'docs', 'drills', `${startedAt.toISOString().slice(0, 10)}-phase67-security-drill.json`)
await mkdir(dirname(path), { recursive: true })
await writeFile(path, `${JSON.stringify(record, null, 2)}\n`)
console.log(`${passed ? 'drill passed' : 'drill FAILED'}; results in ${path}`)
process.exitCode = passed ? 0 : 1
