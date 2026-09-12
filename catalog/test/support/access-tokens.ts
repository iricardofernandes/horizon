import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type CryptoKey, exportJWK, generateKeyPair, SignJWT } from 'jose'

export interface TestRoleAssignment {
  readonly module: string
  readonly role: string
}

export interface TokenOptions {
  readonly tenantId: string
  readonly roles: readonly TestRoleAssignment[]
  readonly subject?: string
  readonly kid?: string
  readonly issuer?: string
  readonly ttlSeconds?: number
  readonly issuedAtOffsetSeconds?: number
}

/**
 * Stands in for Identity: an Ed25519 key pair published at a JWKS endpoint, exactly the
 * document Catalog fetches in production. Tokens are minted here rather than by calling
 * Identity, because a module must be testable with no sibling on disk (ADR 0001).
 */
export class FakeIdentity {
  private constructor(
    private readonly server: Server,
    private readonly privateKey: CryptoKey,
    readonly jwksUrl: string,
    readonly kid: string,
  ) {}

  static async start(kid = 'test-1'): Promise<FakeIdentity> {
    const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' })
    const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'EdDSA', use: 'sig' }
    const server = createServer((request, response) => {
      if (request.url !== '/.well-known/jwks.json') {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, { 'content-type': 'application/jwk-set+json' })
      response.end(JSON.stringify({ keys: [jwk] }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    return new FakeIdentity(
      server,
      privateKey,
      `http://127.0.0.1:${port}/.well-known/jwks.json`,
      kid,
    )
  }

  async mint(options: TokenOptions): Promise<{ token: string; jti: string; subject: string }> {
    const jti = randomUUID()
    const subject = options.subject ?? randomUUID()
    const kid = options.kid ?? this.kid
    const issuedAt = Math.floor(Date.now() / 1000) + (options.issuedAtOffsetSeconds ?? 0)
    const token = await new SignJWT({ tenant_id: options.tenantId, roles: options.roles })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid })
      .setIssuer(options.issuer ?? `horizon-identity-${kid}`)
      .setSubject(subject)
      .setJti(jti)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + (options.ttlSeconds ?? 900))
      .sign(this.privateKey)
    return { token, jti, subject }
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}
