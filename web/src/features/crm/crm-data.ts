'use client'

import { useSession } from '@/components/shell/workspace-context'
import { apiError, readJson, readPage } from '@/lib/api'
import { jsonHeaders } from '@/lib/http'
import { tracedFetch } from '@/lib/telemetry'
import {
  type Account,
  CRM_API,
  type ListEntry,
  type Opportunity,
  type Owner,
  type Pipeline,
} from './types'

/** What every CRM screen may need to name things: accounts, people, pipelines and lists. */
export type CrmDirectory = {
  accounts: Account[]
  owners: Owner[]
  /** User names from Identity, when the session may read them; empty otherwise. */
  names: Map<string, string>
  pipelines: Pipeline[]
  sources: ListEntry[]
  lossReasons: ListEntry[]
}

export type PipelineData = CrmDirectory & { opportunities: Opportunity[] }

/** Identity names are a courtesy: CRM keeps owners as ids, and a viewer may not read users. */
async function loadNames(): Promise<Map<string, string>> {
  try {
    const users = await readPage<{ id: string; name: string }>(
      'identity.users',
      '/api/horizon/identity/users?limit=100',
    )
    return new Map(users.map((user) => [user.id, user.name]))
  } catch {
    return new Map()
  }
}

export async function loadDirectory(): Promise<CrmDirectory> {
  const [accounts, owners, names, pipelines, sources, lossReasons] = await Promise.all([
    readPage<Account>('crm.accounts', `${CRM_API}/accounts?limit=200`),
    readPage<Owner>('crm.owners', `${CRM_API}/owners`),
    loadNames(),
    readPage<Pipeline>('crm.pipelines', `${CRM_API}/pipelines?archived=include`),
    readPage<ListEntry>('crm.sources', `${CRM_API}/sources?archived=include`),
    readPage<ListEntry>('crm.loss-reasons', `${CRM_API}/loss-reasons?archived=include`),
  ])
  return { accounts, owners, names, pipelines, sources, lossReasons }
}

export async function loadPipelineData(): Promise<PipelineData> {
  const [directory, opportunities] = await Promise.all([
    loadDirectory(),
    readPage<Opportunity>('crm.opportunities', `${CRM_API}/opportunities?limit=200`),
  ])
  return { ...directory, opportunities }
}

export function readCrm<T>(name: string, path: string): Promise<T> {
  return readJson<T>(name, `${CRM_API}${path}`)
}

/** What the session's CRM role may attempt; CRM still decides every command (ADR 0023). */
export type CrmAbilities = {
  userId: string | null
  canWrite: boolean
  canAssign: boolean
  canConfigure: boolean
  /** Granting `customer` in Parties is part of converting a prospect. */
  canManageParties: boolean
  canWriteSales: boolean
}

const PERMITS: Record<string, readonly string[]> = {
  admin: ['write', 'assign', 'configure'],
  manager: ['write', 'assign', 'configure'],
  representative: ['write'],
  viewer: [],
}

export function useCrmAbilities(): CrmAbilities {
  const session = useSession()
  const roles = session?.roles ?? []
  const crm = roles
    .filter((role) => role.module === 'crm')
    .flatMap((role) => PERMITS[role.role] ?? [])
  const holds = (module: string, allowed: readonly string[]) =>
    roles.some((role) => role.module === module && allowed.includes(role.role))
  return {
    userId: session?.id ?? null,
    canWrite: crm.includes('write'),
    canAssign: crm.includes('assign'),
    canConfigure: crm.includes('configure'),
    canManageParties: holds('parties', ['admin', 'manager']),
    canWriteSales: holds('sales', ['admin', 'representative']),
  }
}

export type CommandResult<T> = { ok: true; body: T } | { ok: false; error: string }

/**
 * One command through the web proxy. Commands that create something carry an idempotency
 * key (ADR 0028); `key` lets a caller retry under the same one.
 */
export async function send<T = unknown>(
  name: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  options: { body?: unknown; key?: string; fallback: string },
): Promise<CommandResult<T>> {
  const headers: Record<string, string> = options.key
    ? { ...jsonHeaders(), 'idempotency-key': options.key }
    : jsonHeaders()
  const response = await tracedFetch(name, path.startsWith('/api/') ? path : `${CRM_API}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  if (!response.ok) return { ok: false, error: await apiError(response, options.fallback) }
  const text = await response.text()
  return { ok: true, body: (text ? JSON.parse(text) : null) as T }
}

export function newKey(): string {
  return crypto.randomUUID()
}
