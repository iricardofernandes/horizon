import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type CryptoKey, exportJWK, generateKeyPair, SignJWT } from 'jose'

export interface TestKey {
  readonly secret: string
  readonly tenantId: string
  readonly apiKeyId: string
  readonly issuer: string
  readonly scopes: readonly string[]
  readonly roles: readonly { module: string; role: string }[]
}

/** A module read the fake gateway answers, and how. */
export type Route = (query: URLSearchParams) => { status: number; body: unknown }

/**
 * Stands in for Kong in front of Identity and the modules: it publishes a JWKS, exchanges
 * the keys it was given for signed 60-second tokens as Identity does (ADR 0064), and answers
 * module reads only for a token it minted. It counts exchanges and records each read.
 */
export class FakeGateway {
  exchanges = 0
  readonly reads: { path: string; query: string; token: string }[] = []
  readonly #tokens = new Set<string>()

  private constructor(
    private readonly server: Server,
    private readonly privateKey: CryptoKey,
    readonly url: string,
    private readonly keys: Map<string, TestKey>,
    private readonly routes: Map<string, Route>,
  ) {}

  static async start(): Promise<FakeGateway> {
    const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' })
    const jwk = { ...(await exportJWK(publicKey)), kid: 'test-1', alg: 'EdDSA', use: 'sig' }
    const keys = new Map<string, TestKey>()
    const routes = new Map<string, Route>()
    let gateway: FakeGateway | undefined
    const server = createServer((request, response) => {
      void gateway?.handle(request, response, jwk)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    gateway = new FakeGateway(server, privateKey, `http://127.0.0.1:${port}`, keys, routes)
    return gateway
  }

  get jwksUrl(): string {
    return `${this.url}/.well-known/jwks.json`
  }

  addKey(key: TestKey): void {
    this.keys.set(key.secret, key)
  }

  route(path: string, answer: Route): void {
    this.routes.set(path, answer)
  }

  /** A person's token, as Identity mints one at sign-in (no `scp`). */
  person(
    tenantId: string,
    roles: readonly { module: string; role: string }[],
    subject = randomUUID(),
  ) {
    return this.sign({ tenant_id: tenantId, roles }, subject, 900)
  }

  private async sign(claims: Record<string, unknown>, subject: string, ttl: number) {
    const now = Math.floor(Date.now() / 1000)
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: 'test-1' })
      .setIssuer('horizon-identity-test-1')
      .setSubject(subject)
      .setJti(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + ttl)
      .sign(this.privateKey)
    this.#tokens.add(token)
    return token
  }

  private async handle(request: IncomingMessage, response: ServerResponse, jwk: object) {
    const url = new URL(request.url ?? '/', this.url)
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    if (url.pathname === '/.well-known/jwks.json') return reply(200, { keys: [jwk] })
    if (request.method === 'POST' && url.pathname === '/auth/api-key/token') {
      this.exchanges += 1
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk as Buffer)
      const { tenantId, presented } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const key = this.keys.get(presented)
      // A key is looked up inside the tenant it is addressed to: another tenant's is unknown.
      if (!key || key.tenantId !== tenantId) return reply(401, { detail: 'invalid credentials' })
      const reached = new Set(key.scopes.map((scope) => scope.split(':')[0]))
      const accessToken = await this.sign(
        {
          tenant_id: tenantId,
          roles: key.roles.filter((role) => reached.has(role.module)),
          scp: key.scopes,
          key_issuer: key.issuer,
        },
        `api-key:${key.apiKeyId}`,
        60,
      )
      return reply(200, {
        tenantId,
        apiKeyId: key.apiKeyId,
        accessToken,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        scopes: key.scopes,
      })
    }
    const token = request.headers.authorization?.replace(/^Bearer /, '') ?? ''
    if (!this.#tokens.has(token)) return reply(401, { detail: 'unknown token' })
    const route = this.routes.get(url.pathname)
    if (!route) return reply(404, { detail: 'not found' })
    this.reads.push({ path: url.pathname, query: url.search, token })
    const answer = route(url.searchParams)
    return reply(answer.status, answer.body)
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}
