import { type OwnerAnswer, OwnerReports } from '@/application/ports/report-store'

/**
 * Reads an owner's own report through the gateway, with the caller's token (Phase 62).
 * Only `GET`, only the paths the report catalogue names, and the token is never stored or
 * logged: reporting holds no access of its own to any other module.
 */
export class GatewayOwnerReports extends OwnerReports {
  constructor(
    private readonly gatewayUrl: string,
    private readonly timeoutMs = 10_000,
  ) {
    super()
  }

  async read(
    path: string,
    query: Readonly<Record<string, string>>,
    bearer: string,
  ): Promise<OwnerAnswer> {
    const url = new URL(path, this.gatewayUrl)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    let response: Response
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch {
      return { status: 'unavailable' }
    }
    if (response.status === 401 || response.status === 403) return { status: 'forbidden' }
    if (!response.ok) return { status: 'unavailable' }
    try {
      return { status: 'ok', body: await response.json() }
    } catch {
      return { status: 'unavailable' }
    }
  }
}
