import { tracedFetch } from '@/lib/telemetry'

/** The session is gone: the caller sends the user back to the login screen. */
export class SessionExpiredError extends Error {}

/** The upstream refused or is unreachable: the screen renders its error state. */
export class ResourceUnavailableError extends Error {}

export async function readJson<T>(name: string, url: string): Promise<T> {
  const response = await tracedFetch(name, url, { cache: 'no-store' })
  if (response.status === 401) throw new SessionExpiredError(name)
  if (!response.ok) throw new ResourceUnavailableError(name)
  return (await response.json()) as T
}

/** Reads a paginated collection, which the API returns as `{ data: [...] }`. */
export async function readPage<T>(name: string, url: string): Promise<T[]> {
  return (await readJson<{ data: T[] }>(name, url)).data
}

/** The RFC 9457 detail the API returned, or a caller-supplied fallback. */
export async function apiError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown; message?: unknown }
    const value = body.detail ?? body.message
    if (typeof value === 'string') return value
  } catch {}
  return fallback
}
