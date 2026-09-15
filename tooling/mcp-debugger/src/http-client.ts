export async function fetchJson<T>(url: URL, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(10_000),
    headers: { accept: 'application/json', ...init?.headers },
  })
  if (!response.ok) throw new Error(`Upstream ${url.host} returned HTTP ${response.status}`)
  return (await response.json()) as T
}
