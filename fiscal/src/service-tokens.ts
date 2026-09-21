import { z } from 'zod'

const responseSchema = z.strictObject({
  tenantId: z.uuid(),
  accessToken: z.string().min(20),
  expiresAt: z.iso.datetime({ offset: true }),
})

/** Exchanges rotatable, tenant-scoped API keys for short-lived owner reader tokens. */
export class FiscalServiceTokens {
  private readonly cached = new Map<string, { token: string; expiresAt: number }>()
  private readonly pending = new Map<string, Promise<string>>()

  constructor(
    private readonly identityUrl: string,
    private readonly keys: Readonly<Record<string, string>>,
  ) {}

  async forTenant(tenantId: string): Promise<string> {
    const cached = this.cached.get(tenantId)
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token
    const running = this.pending.get(tenantId)
    if (running) return running
    const key = this.keys[tenantId]
    if (!key) throw new Error('Fiscal service credential is missing for tenant')
    const exchange = this.exchange(tenantId, key)
    this.pending.set(tenantId, exchange)
    try {
      return await exchange
    } finally {
      this.pending.delete(tenantId)
    }
  }

  private async exchange(tenantId: string, presented: string): Promise<string> {
    const response = await fetch(new URL('/auth/fiscal-token', this.identityUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ tenantId, presented }),
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok)
      throw new Error(`Fiscal service token exchange failed: HTTP ${response.status}`)
    const result = responseSchema.parse(await response.json())
    if (result.tenantId !== tenantId) throw new Error('Fiscal service token tenant mismatch')
    const expiresAt = Date.parse(result.expiresAt)
    if (expiresAt <= Date.now() + 60_000)
      throw new Error('Fiscal service token lifetime is too short')
    this.cached.set(tenantId, { token: result.accessToken, expiresAt })
    return result.accessToken
  }
}
