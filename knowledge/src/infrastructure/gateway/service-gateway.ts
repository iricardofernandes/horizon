import { z } from 'zod'

const tokenAnswer = z.object({ accessToken: z.string().min(1), accessTokenExpiresAt: z.string() })

/**
 * The gateway as the `knowledge` service client sees it (Phase 69): a short token per
 * tenant, kept until a minute before it ends, and reads with it. Its roles are fixed in
 * Identity's `SERVICE_GRANTS`: a viewer of the modules it indexes, and nothing more.
 */
export class ServiceGateway {
  readonly #tokens = new Map<string, { token: string; expiresAt: number }>()

  constructor(
    private readonly gatewayUrl: string,
    private readonly secret: string,
    private readonly timeoutMs = 30_000,
  ) {}

  get(path: string, token?: string): Promise<Response> {
    return fetch(new URL(path, this.gatewayUrl), {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(this.timeoutMs),
    })
  }

  async tokenFor(tenantId: string): Promise<string> {
    const cached = this.#tokens.get(tenantId)
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token
    const response = await fetch(new URL('/auth/service-token', this.gatewayUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client: 'knowledge', secret: this.secret, tenantId }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok) throw new Error(`service token refused with ${response.status}`)
    const answer = tokenAnswer.parse(await response.json())
    this.#tokens.set(tenantId, {
      token: answer.accessToken,
      expiresAt: Date.parse(answer.accessTokenExpiresAt),
    })
    return answer.accessToken
  }
}
