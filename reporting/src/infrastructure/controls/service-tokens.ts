import { z } from 'zod'

const answer = z.object({ accessToken: z.string().min(1) })

/**
 * The service identity for scheduled work (Phase 69): Identity issues a short-lived,
 * read-only token for one tenant to the `reporting` client that proves its secret. The
 * secret and the tokens are never logged or stored.
 */
export class ServiceTokens {
  constructor(
    private readonly gatewayUrl: string,
    private readonly secret: string,
    private readonly timeoutMs = 10_000,
  ) {}

  async tokenFor(tenantId: string): Promise<string> {
    const response = await fetch(new URL('/auth/service-token', this.gatewayUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client: 'reporting', secret: this.secret, tenantId }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok) throw new Error(`service token refused with ${response.status}`)
    return answer.parse(await response.json()).accessToken
  }
}
