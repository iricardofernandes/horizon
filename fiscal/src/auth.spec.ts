import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { exportJWK, SignJWT } from 'jose'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { type Denylist, FiscalTokenVerifier, may } from './auth'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
let server: ReturnType<typeof createServer>
let verifier: FiscalTokenVerifier
let denied = false
const denylist: Denylist = {
  async check() {
    return !denied
  },
  async close() {},
}

beforeAll(async () => {
  const jwk = await exportJWK(publicKey)
  server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ keys: [{ ...jwk, kid: 'test-1', alg: 'EdDSA', use: 'sig' }] }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('JWKS test server has no port')
  verifier = new FiscalTokenVerifier(`http://127.0.0.1:${address.port}/jwks`, denylist)
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function token(roles: { module: string; role: string }[]): Promise<string> {
  return new SignJWT({ tenant_id: randomUUID(), roles })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: 'test-1' })
    .setIssuer('horizon-identity-test-1')
    .setSubject(randomUUID())
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(privateKey)
}

it('verifies Identity signatures and expands Fiscal roles locally', async () => {
  const principal = await verifier.verify(
    `Bearer ${await token([{ module: 'fiscal', role: 'issuer' }])}`,
  )
  expect(principal.role).toBe('issuer')
  expect(may(principal, 'draft:create')).toBe(true)
  expect(may(principal, 'rules:manage')).toBe(false)
  expect(may({ ...principal, role: 'viewer' }, 'transmission:submit')).toBe(false)
})

it('rejects foreign roles and revoked tokens', async () => {
  await expect(
    verifier.verify(`Bearer ${await token([{ module: 'catalog', role: 'admin' }])}`),
  ).rejects.toThrow('Invalid fiscal access token')
  denied = true
  try {
    await expect(
      verifier.verify(`Bearer ${await token([{ module: 'fiscal', role: 'admin' }])}`),
    ).rejects.toThrow('Invalid fiscal access token')
  } finally {
    denied = false
  }
})
