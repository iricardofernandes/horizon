import { createPrivateKey, createPublicKey, type KeyObject, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { jwtVerify, SignJWT } from 'jose'
import { z } from 'zod'

import {
  AccessTokenSigner,
  type JsonWebKey,
  type MintedAccessToken,
  type VerifiedAccessToken,
} from '@/application/ports/access-token-signer'
import type { Clock } from '@/application/ports/clock'
import { type Either, left, right } from '@/core/either'
import type { UserClaims } from '@/domain/entities/user'
import { InvalidAccessTokenError } from '@/domain/errors/invalid-access-token-error'
import { SystemClock } from './system-clock'

interface SigningPolicy {
  readonly activeKid: string
  readonly ttlSeconds?: number
  readonly clock?: Clock
}

export interface EdDsaAccessTokenSignerOptions extends SigningPolicy {
  readonly privateKeyPem: string
  readonly publicKeys: readonly { readonly kid: string; readonly pem: string }[]
}

export interface EdDsaAccessTokenFilesOptions extends SigningPolicy {
  readonly privateKeyPath: string
  readonly publicKeysDirectory: string
}

const CLAIMS = z.object({
  sub: z.string().min(1),
  tenant_id: z.string().min(1),
  roles: z.array(z.object({ module: z.string().min(1), role: z.string().min(1) })),
  jti: z.string().min(1),
  iss: z.string().min(1),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
})

/**
 * A boot-time key ring. Publish old and new keys during rotation, switch activeKid,
 * and rebuild the instance; retire the old public key only after every token expires.
 */
export class EdDsaAccessTokenSigner extends AccessTokenSigner {
  private readonly privateKey: KeyObject
  private readonly publicKeys = new Map<string, KeyObject>()
  private readonly publicJwks: readonly JsonWebKey[]
  private readonly kid: string
  private readonly ttlSeconds: number
  private readonly clock: Clock

  constructor(options: EdDsaAccessTokenSignerOptions) {
    super()
    this.kid = options.activeKid
    this.ttlSeconds = options.ttlSeconds ?? 900
    this.clock = options.clock ?? new SystemClock()
    if (!Number.isSafeInteger(this.ttlSeconds) || this.ttlSeconds <= 0)
      throw new Error('Access token TTL must be a positive safe integer')

    this.privateKey = createPrivateKey(options.privateKeyPem)
    this.assertEd25519(this.privateKey)
    this.publicJwks = Object.freeze(options.publicKeys.map((key) => this.addPublicKey(key)))

    const activePublicKey = this.publicKeys.get(this.kid)
    if (activePublicKey === undefined) throw new Error('Active signing key is missing from JWKS')
    if (!createPublicKey(this.privateKey).equals(activePublicKey))
      throw new Error('Active private key does not match its published public key')
  }

  /** Uses the exact naming convention produced by infra/scripts/generate-keys.sh. */
  static fromFiles(options: EdDsaAccessTokenFilesOptions): EdDsaAccessTokenSigner {
    const publicKeys = readdirSync(options.publicKeysDirectory)
      .filter((filename) => filename.endsWith('.pem'))
      .sort()
      .map((filename) => {
        const kid = /^ed25519-(.+)-public\.pem$/.exec(filename)?.[1]
        if (kid === undefined) throw new Error('Unexpected public signing key filename')
        return { kid, pem: readFileSync(join(options.publicKeysDirectory, filename), 'utf8') }
      })
    return new EdDsaAccessTokenSigner({
      ...options,
      privateKeyPem: readFileSync(options.privateKeyPath, 'utf8'),
      publicKeys,
    })
  }

  override async mint(claims: UserClaims, now: Date): Promise<MintedAccessToken> {
    const issuedAtSeconds = Math.floor(now.getTime() / 1000)
    const expiresAtSeconds = issuedAtSeconds + this.ttlSeconds
    const jti = randomUUID()
    const token = await new SignJWT({ tenant_id: claims.tenantId, roles: claims.roles })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: this.kid })
      // Kong OSS selects a configured credential by iss, not by JWKS (ADR 0036).
      .setIssuer(this.issuer(this.kid))
      .setSubject(claims.subject)
      .setJti(jti)
      .setIssuedAt(issuedAtSeconds)
      .setExpirationTime(expiresAtSeconds)
      .sign(this.privateKey)

    return {
      token,
      jti,
      kid: this.kid,
      issuedAt: new Date(issuedAtSeconds * 1000),
      expiresAt: new Date(expiresAtSeconds * 1000),
    }
  }

  override async verify(
    token: string,
  ): Promise<Either<InvalidAccessTokenError, VerifiedAccessToken>> {
    try {
      const { payload, protectedHeader } = await jwtVerify(
        token,
        (header) => {
          const key = header.kid === undefined ? undefined : this.publicKeys.get(header.kid)
          if (key === undefined) throw new Error('Unknown signing key')
          return key
        },
        {
          algorithms: ['EdDSA'],
          typ: 'JWT',
          currentDate: this.clock.now(),
          maxTokenAge: this.ttlSeconds,
          requiredClaims: ['sub', 'tenant_id', 'roles', 'jti', 'iss', 'iat', 'exp'],
        },
      )
      const claims = CLAIMS.parse(payload)
      if (claims.iss !== this.issuer(protectedHeader.kid ?? ''))
        return left(new InvalidAccessTokenError())
      if (claims.exp <= claims.iat || claims.exp - claims.iat > this.ttlSeconds)
        return left(new InvalidAccessTokenError())

      return right({
        subject: claims.sub,
        tenantId: claims.tenant_id,
        roles: claims.roles,
        jti: claims.jti,
        expiresAt: new Date(claims.exp * 1000),
      })
    } catch {
      return left(new InvalidAccessTokenError())
    }
  }

  override jwks(): readonly JsonWebKey[] {
    return this.publicJwks
  }

  override activeKid(): string {
    return this.kid
  }

  private addPublicKey(entry: { readonly kid: string; readonly pem: string }): JsonWebKey {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.kid))
      throw new Error('Signing key identifier is invalid')
    if (this.publicKeys.has(entry.kid)) throw new Error('Duplicate signing key identifier')

    const key = createPublicKey(entry.pem)
    this.assertEd25519(key)
    const jwk = key.export({ format: 'jwk' })
    if (typeof jwk.x !== 'string') throw new Error('Signing key has no public coordinate')
    this.publicKeys.set(entry.kid, key)
    return Object.freeze({
      kty: 'OKP',
      crv: 'Ed25519',
      x: jwk.x,
      kid: entry.kid,
      alg: 'EdDSA',
      use: 'sig',
    })
  }

  private assertEd25519(key: KeyObject): void {
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('Signing keys must use Ed25519')
  }

  private issuer(kid: string): string {
    return `horizon-identity-${kid}`
  }
}
