import { headers } from 'next/headers'

const apiUrl = process.env.HORIZON_API_URL ?? 'http://localhost:8000'

/**
 * Every call from the web server to Kong (ADR 0008) goes through here, so Kong limits each
 * browser by its own address (Phase 80) rather than counting every browser as this server.
 * The address is the one `trusted-address.cjs` set for the request.
 */
export async function gatewayFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const forwarded = new Headers(init.headers)
  const address = (await headers()).get('x-forwarded-for')
  if (address) forwarded.set('x-forwarded-for', address)
  return fetch(`${apiUrl}${path}`, { ...init, headers: forwarded })
}
