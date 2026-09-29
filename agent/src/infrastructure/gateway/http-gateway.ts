import { apiKeyTokenResponseSchema } from '@horizon/contracts'
import { type KeyClaims, KeyTokens } from '@/application/agent-calls'
import {
  type ExchangedKey,
  type ExchangeRefusal,
  Gateway,
  type GatewayAnswer,
  KeyExchange,
} from '@/application/ports'
import type { AccessTokenVerifier } from '@/infrastructure/cryptography/access-token-verifier'

async function bodyOf(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

const detailOf = (body: unknown): string => {
  const detail = (body as { detail?: unknown } | null)?.detail
  return typeof detail === 'string' ? detail.slice(0, 200) : 'The key was refused'
}

/** Identity's exchange, reached through Kong like any client (ADR 0064). */
export class HttpKeyExchange extends KeyExchange {
  constructor(
    private readonly gatewayUrl: string,
    private readonly timeoutMs: number,
  ) {
    super()
  }

  async exchange(
    tenantId: string,
    presented: string,
  ): Promise<{ ok: true; key: ExchangedKey } | { ok: false; refusal: ExchangeRefusal }> {
    const response = await fetch(new URL('/auth/api-key/token', this.gatewayUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify({ tenantId, presented }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const body = await bodyOf(response)
    if (response.status !== 200) {
      const retryAfter = Number(response.headers.get('retry-after'))
      return {
        ok: false,
        refusal: {
          // A 422 is a malformed key: to the agent it is as unusable as a wrong one.
          status: response.status === 422 ? 401 : response.status,
          detail: detailOf(body),
          ...(Number.isFinite(retryAfter) && retryAfter > 0
            ? { retryAfterSeconds: retryAfter }
            : {}),
        },
      }
    }
    const parsed = apiKeyTokenResponseSchema.parse(body)
    if (parsed.tenantId !== tenantId) throw new Error('the exchange answered another tenant')
    return {
      ok: true,
      key: { apiKeyId: parsed.apiKeyId, accessToken: parsed.accessToken, scopes: parsed.scopes },
    }
  }
}

/** Reads through Kong with the caller's own token, so every module's checks apply. */
export class HttpGateway extends Gateway {
  constructor(
    private readonly gatewayUrl: string,
    private readonly timeoutMs: number,
  ) {
    super()
  }

  async read(
    path: string,
    query: Readonly<Record<string, string>>,
    accessToken: string,
  ): Promise<GatewayAnswer> {
    const url = new URL(path, this.gatewayUrl)
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value)
    // A path that left the gateway's origin would be a bug in the catalogue; refuse it.
    if (url.origin !== new URL(this.gatewayUrl).origin) throw new Error('refusing a foreign URL')
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    return { status: response.status, body: await bodyOf(response) }
  }
}

/** The claims of a freshly exchanged token, verified against Identity's published keys. */
export class VerifiedKeyTokens extends KeyTokens {
  constructor(private readonly verifier: AccessTokenVerifier) {
    super()
  }

  async read(accessToken: string): Promise<KeyClaims> {
    const claims = await this.verifier.verify(accessToken)
    return {
      tenantId: claims.tenantId,
      scopes: claims.scopes ?? [],
      keyIssuer: claims.keyIssuer ?? null,
    }
  }
}
