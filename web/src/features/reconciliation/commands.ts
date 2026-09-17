import { apiError } from '@/lib/api'
import { idempotentJsonHeaders, jsonHeaders } from '@/lib/http'
import { tracedFetch } from '@/lib/telemetry'

export const TREASURY_API = '/api/horizon/treasury'

/** Posts a treasury command; resolves to null on success or the API's reason on refusal. */
export async function post(
  name: string,
  path: string,
  body: unknown,
  fallback: string,
  options: { idempotent?: boolean } = { idempotent: true },
): Promise<string | null> {
  const response = await tracedFetch(name, `${TREASURY_API}${path}`, {
    method: 'POST',
    headers: options.idempotent === false ? jsonHeaders() : idempotentJsonHeaders(),
    body: JSON.stringify(body),
  })
  return response.ok ? null : apiError(response, fallback)
}
