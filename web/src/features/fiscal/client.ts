'use client'

import { useSession } from '@/components/shell/workspace-context'
import { idempotentJsonHeaders } from '@/lib/http'
import { tracedFetch } from '@/lib/telemetry'
import { FISCAL_API, type FiscalRole, fiscalRoleOf } from './types'

export type CommandOutcome =
  | { ok: true; body: unknown }
  | { ok: false; status: number; code: string | null; detail: string | null }

/**
 * Every Fiscal write carries an idempotency key (ADR 0028). A refusal keeps the server's
 * stable code and detail, which the view shows as sent: the screen never guesses a state.
 */
export async function fiscalCommand(
  name: string,
  path: string,
  body?: unknown,
): Promise<CommandOutcome> {
  const response = await tracedFetch(name, `${FISCAL_API}${path}`, {
    method: 'POST',
    headers: idempotentJsonHeaders(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const payload = await response.json().catch(() => null)
  if (response.ok) return { ok: true, body: payload }
  const problem = (payload ?? {}) as { code?: unknown; detail?: unknown }
  return {
    ok: false,
    status: response.status,
    code: typeof problem.code === 'string' ? problem.code : null,
    detail: typeof problem.detail === 'string' ? problem.detail : null,
  }
}

/** The caller's Fiscal role, for visibility only; Fiscal enforces it (ADR 0045). */
export function useFiscalRole(): FiscalRole | null {
  const session = useSession()
  return fiscalRoleOf(session?.roles ?? [])
}
