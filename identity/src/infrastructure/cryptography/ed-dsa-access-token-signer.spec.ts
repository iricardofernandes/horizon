import { generateKeyPairSync } from 'node:crypto'

import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify, SignJWT } from 'jose'

import { InvalidAccessTokenError } from '@/domain/errors/invalid-access-token-error'
import { EdDsaAccessTokenSigner } from './ed-dsa-access-token-signer'

function makeKey(kid: string) {
  const pair = generateKeyPairSync('ed25519')
  return {
    kid,
    privateKey: pair.privateKey,
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    pem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
}

describe('EdDsaAccessTokenSigner', () => {
  const oldKey = makeKey('old-1')
  const newKey = makeKey('new-2')
  const now = new Date('2026-09-10T12:00:00.321Z')
  const issuedAt = Math.floor(now.getTime() / 1000)
  const claims = {
    subject: 'user-1',
    tenantId: 'tenant-1',
    roles: [{ module: 'sales', role: 'viewer' }],
  }
  const payload = {
    sub: claims.subject,
    tenant_id: claims.tenantId,
    roles: claims.roles,
    jti: 'token-1',
    iss: 'horizon-identity-old-1',
    iat: issuedAt,
    exp: issuedAt + 900,
  }
  const options = {
    activeKid: oldKey.kid,
    privateKeyPem: oldKey.privateKeyPem,
    publicKeys: [oldKey, newKey],
    clock: { now: () => now },
  }
  const signer = new EdDsaAccessTokenSigner(options)

  it('mints gateway-compatible claims and verifies using its published JWKS', async () => {
    const minted = await signer.mint(claims, now)
    const verified = await signer.verify(minted.token)
    const external = await jwtVerify(
      minted.token,
      createLocalJWKSet({ keys: [...signer.jwks()] }),
      { algorithms: ['EdDSA'], issuer: 'horizon-identity-old-1', currentDate: now },
    )

    expect(verified.isRight()).toBe(true)
    expect(verified.value).toEqual({
      ...claims,
      jti: minted.jti,
      expiresAt: new Date((issuedAt + 900) * 1000),
    })
    expect(decodeProtectedHeader(minted.token)).toEqual({
      alg: 'EdDSA',
      typ: 'JWT',
      kid: oldKey.kid,
    })
    expect(external.payload).toMatchObject({ ...payload, jti: minted.jti })
    expect(minted.issuedAt).toEqual(new Date(issuedAt * 1000))
    expect(minted.expiresAt.getTime() - minted.issuedAt.getTime()).toBe(900_000)
    expect((await signer.mint(claims, now)).jti).not.toBe(minted.jti)
  })

  it('keeps both generations verifiable while only the active key signs', async () => {
    const rotated = new EdDsaAccessTokenSigner({
      ...options,
      activeKid: newKey.kid,
      privateKeyPem: newKey.privateKeyPem,
    })
    const oldToken = await signer.mint(claims, now)
    const newToken = await rotated.mint(claims, now)

    expect((await rotated.verify(oldToken.token)).isRight()).toBe(true)
    expect((await signer.verify(newToken.token)).isRight()).toBe(true)
    expect(rotated.activeKid()).toBe(newKey.kid)
    expect(newToken.kid).toBe(newKey.kid)
    expect(decodeJwt(newToken.token).iss).toBe('horizon-identity-new-2')
    expect(rotated.jwks().map((key) => key.kid)).toEqual([oldKey.kid, newKey.kid])
  })

  it('stops accepting the retired key after it leaves the ring', async () => {
    const rotated = new EdDsaAccessTokenSigner({
      ...options,
      activeKid: newKey.kid,
      privateKeyPem: newKey.privateKeyPem,
      publicKeys: [newKey],
    })

    expect((await rotated.verify((await signer.mint(claims, now)).token)).isLeft()).toBe(true)
  })

  it('exposes frozen public material with no private coordinates', () => {
    expect(Object.isFrozen(signer.jwks())).toBe(true)
    for (const key of signer.jwks()) {
      expect(Object.keys(key).sort()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x'])
      expect(Object.isFrozen(key)).toBe(true)
      expect(key).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig' })
    }
  })

  it('rejects alg none and symmetric algorithm confusion', async () => {
    const unsigned = [
      Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT', kid: oldKey.kid })).toString(
        'base64url',
      ),
      Buffer.from(JSON.stringify(payload)).toString('base64url'),
      '',
    ].join('.')
    const symmetric = await new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT', kid: oldKey.kid })
      .sign(Buffer.from(oldKey.pem))

    expect((await signer.verify(unsigned)).value).toBeInstanceOf(InvalidAccessTokenError)
    expect((await signer.verify(symmetric)).value).toBeInstanceOf(InvalidAccessTokenError)
  })

  it('rejects a valid signature with an unknown kid and a wrong signature with a known kid', async () => {
    const unknownKid = await new SignJWT(payload)
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: 'unknown' })
      .sign(oldKey.privateKey)
    const wrongKey = await new SignJWT(payload)
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: oldKey.kid })
      .sign(newKey.privateKey)

    expect((await signer.verify(unknownKid)).isLeft()).toBe(true)
    expect((await signer.verify(wrongKey)).isLeft()).toBe(true)
  })

  it('rejects altered payloads and malformed tokens', async () => {
    const token = (await signer.mint(claims, now)).token.split('.')
    token[1] = Buffer.from(JSON.stringify({ ...payload, tenant_id: 'other-tenant' })).toString(
      'base64url',
    )

    expect((await signer.verify(token.join('.'))).isLeft()).toBe(true)
    expect((await signer.verify('invalid')).isLeft()).toBe(true)
  })

  it('expires at the exact exp second and rejects tokens from the future', async () => {
    const expired = new EdDsaAccessTokenSigner({
      ...options,
      clock: { now: () => new Date((issuedAt + 900) * 1000) },
    })
    const future = new Date(now.getTime() + 1000)

    expect((await expired.verify((await signer.mint(claims, now)).token)).isLeft()).toBe(true)
    expect((await signer.verify((await signer.mint(claims, future)).token)).isLeft()).toBe(true)
  })

  it.each([
    { tenant_id: undefined },
    { tenant_id: '' },
    { sub: undefined },
    { sub: 42 },
    { roles: undefined },
    { roles: ['admin'] },
    { roles: [{ module: 'sales' }] },
    { jti: '' },
    { iat: undefined },
    { exp: undefined },
    { exp: issuedAt + 901 },
    { iss: 'other-issuer' },
    { iss: 'horizon-identity-new-2' },
  ])('rejects signed tokens with invalid claims: %j', async (overrides) => {
    const token = await new SignJWT({ ...payload, ...overrides })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: oldKey.kid })
      .sign(oldKey.privateKey)

    expect((await signer.verify(token)).value).toBeInstanceOf(InvalidAccessTokenError)
  })

  it('refuses missing, mismatched or duplicate active keys at boot', () => {
    expect(() => new EdDsaAccessTokenSigner({ ...options, activeKid: 'missing' })).toThrow()
    expect(
      () => new EdDsaAccessTokenSigner({ ...options, privateKeyPem: newKey.privateKeyPem }),
    ).toThrow()
    expect(() => new EdDsaAccessTokenSigner({ ...options, publicKeys: [oldKey, oldKey] })).toThrow()
  })

  it('refuses non-Ed25519 key material', () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' })

    expect(
      () =>
        new EdDsaAccessTokenSigner({
          ...options,
          privateKeyPem: other.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        }),
    ).toThrow('Signing keys must use Ed25519')
  })
})
