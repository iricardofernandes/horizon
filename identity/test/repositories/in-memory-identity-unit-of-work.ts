import type { TenantScope, UnitOfWork } from '@/application/ports/unit-of-work'
import type { DomainEvent } from '@/core/events/domain-event'
import type { Page, PaginationParams } from '@/core/repositories/pagination-params'
import type { AuditEntry } from '@/domain/audit/audit-entry'
import type { ApiKey } from '@/domain/entities/api-key'
import type { DataSubjectKey } from '@/domain/entities/data-subject-key'
import type { Tenant } from '@/domain/entities/tenant'
import type { User } from '@/domain/entities/user'
import type { AuditRecord } from '@/domain/repositories/audit-log-repository'
import { makeAuditEntry } from '../factories/make-audit-entry'

function page<T extends { id: { toString(): string } }>(
  records: readonly T[],
  params: PaginationParams,
): Page<T> {
  const start =
    params.cursor === undefined
      ? 0
      : records.findIndex((item) => item.id.toString() === params.cursor) + 1
  const items = records.slice(start, start + params.limit)
  const hasMore = start + items.length < records.length
  const last = items.at(-1)
  return { items, hasMore, ...(hasMore && last ? { nextCursor: last.id.toString() } : {}) }
}

/** Each scope owns a separate store; writes reject an aggregate belonging to another tenant. */
export class InMemoryIdentityUnitOfWork implements UnitOfWork {
  private readonly scopes = new Map<string, ReturnType<typeof createScope>>()
  private readonly slugs = new Map<string, string>()
  readonly directory = {
    resolve: async (slug: string) => this.slugs.get(slug) ?? null,
    slugExists: async (slug: string) => this.slugs.has(slug),
    register: async (slug: string, tenantId: string) => {
      if (this.slugs.has(slug)) throw new Error('Duplicate tenant slug')
      this.slugs.set(slug, tenantId)
    },
  }

  scope(tenantId: string) {
    let scope = this.scopes.get(tenantId)
    if (!scope) {
      scope = createScope(tenantId)
      this.scopes.set(tenantId, scope)
    }
    return scope
  }

  async inTenant<T>(tenantId: string, work: (scope: TenantScope) => Promise<T>): Promise<T> {
    return work(this.scope(tenantId))
  }
}

function createScope(tenantId: string) {
  const userRows = new Map<string, User>()
  const tenantRows = new Map<string, Tenant>()
  const apiKeyRows = new Map<string, ApiKey>()
  const keyRows = new Map<string, DataSubjectKey>()
  const auditRecords: AuditRecord[] = []
  const entries: AuditEntry[] = []
  const events: DomainEvent[] = []
  const writes: string[] = []
  function enforceTenant(actual: string) {
    if (actual !== tenantId) throw new Error('Cross-tenant write refused')
  }
  async function saveUser(user: User) {
    enforceTenant(user.claims().tenantId)
    userRows.set(user.id.toString(), user)
    events.push(...user.pullDomainEvents())
    writes.push('user')
  }
  async function saveTenant(tenant: Tenant) {
    enforceTenant(tenant.id.toString())
    tenantRows.set(tenant.id.toString(), tenant)
    events.push(...tenant.pullDomainEvents())
    writes.push('tenant')
  }
  async function saveApiKey(key: ApiKey) {
    enforceTenant(key.toSnapshot().tenantId)
    apiKeyRows.set(key.id.toString(), key)
    events.push(...key.pullDomainEvents())
    writes.push('api-key')
  }
  async function saveKey(key: DataSubjectKey) {
    enforceTenant(key.toSnapshot().tenantId)
    keyRows.set(key.id.toString(), key)
    writes.push('subject-key')
  }
  return {
    tenantId,
    userRows,
    tenantRows,
    apiKeyRows,
    keyRows,
    auditRecords,
    events,
    writes,
    tenants: {
      findById: async (id: string) => tenantRows.get(id) ?? null,
      create: saveTenant,
      save: saveTenant,
      list: async (params: PaginationParams) => page([...tenantRows.values()], params),
    },
    users: {
      findById: async (id: string) => userRows.get(id) ?? null,
      findByEmail: async (email: { value: string }) =>
        [...userRows.values()].find((user) => user.toSnapshot().email === email.value) ?? null,
      create: saveUser,
      save: saveUser,
      list: async (params: PaginationParams) => page([...userRows.values()], params),
      countActive: async () =>
        [...userRows.values()].filter((user) => user.canAuthenticate()).length,
    },
    apiKeys: {
      findById: async (id: string) => apiKeyRows.get(id) ?? null,
      findByPrefix: async (prefix: string) =>
        [...apiKeyRows.values()].find((key) => key.toSnapshot().prefix === prefix) ?? null,
      create: saveApiKey,
      save: saveApiKey,
      list: async (params: PaginationParams) => page([...apiKeyRows.values()], params),
      listIssuedBy: async (id: string) =>
        [...apiKeyRows.values()].filter((key) => key.issuer() === id),
    },
    dataSubjectKeys: {
      findBySubject: async (id: string) => keyRows.get(id) ?? null,
      create: saveKey,
      save: saveKey,
    },
    audit: {
      append: async (record: AuditRecord) => {
        auditRecords.push(record)
        const entry = makeAuditEntry(
          {
            tenantId,
            sequence: entries.length + 1,
            action: record.action,
            occurredAt: record.occurredAt,
          },
          entries.at(-1)?.hashValue(),
        )
        entries.push(entry)
        writes.push('audit')
        return entry
      },
      walk: async (from: number, limit: number) =>
        entries.filter((entry) => entry.sequenceNumber() >= from).slice(0, limit),
      lastSequence: async () => entries.length,
    },
    outbox: {
      publish: async (published: readonly DomainEvent[]) => {
        events.push(...published)
      },
    },
  }
}
