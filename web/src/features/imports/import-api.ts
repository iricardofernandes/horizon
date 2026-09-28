import { apiError } from '@/lib/api'
import { jsonHeaders } from '@/lib/http'
import type { ImportingModule, ImportJob, ImportKind, ImportPreview } from '@/lib/import-file'
import { tracedFetch } from '@/lib/telemetry'

/** Calls one module's import job contract through the proxy, as the signed-in user. */
export function importApi(module: ImportingModule, failed: string) {
  const base = `/api/horizon/${module}/imports`
  async function call<T>(name: string, url: string, init?: RequestInit): Promise<T> {
    const response = await tracedFetch(`${module}.imports.${name}`, url, init)
    if (!response.ok) throw new Error(await apiError(response, failed))
    return (await response.json()) as T
  }
  return {
    kinds: () => call<{ data: ImportKind[] }>('kinds', `${base}/kinds`).then((r) => r.data),
    list: () => call<{ data: ImportJob[] }>('list', base).then((r) => r.data),
    get: (id: string) => call<ImportJob>('get', `${base}/${id}`),
    upload: (kind: string, key: string, body: unknown) =>
      call<ImportJob>('upload', `${base}/${kind}`, {
        method: 'POST',
        headers: { ...jsonHeaders(), 'idempotency-key': key },
        body: JSON.stringify(body),
      }),
    map: (id: string, mapping: Record<string, string | null>) =>
      call<ImportJob>('map', `${base}/${id}/mapping`, {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({ mapping }),
      }),
    preview: (id: string) =>
      call<ImportPreview>('preview', `${base}/${id}/preview`, { method: 'POST' }),
    confirm: (id: string) =>
      call<ImportJob>('confirm', `${base}/${id}/confirm`, { method: 'POST' }),
    cancel: (id: string) => call<ImportJob>('cancel', `${base}/${id}/cancel`, { method: 'POST' }),
    failuresUrl: (id: string) => `${base}/${id}/failures`,
  }
}

export type ImportApi = ReturnType<typeof importApi>
