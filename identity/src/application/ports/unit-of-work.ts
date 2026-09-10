import type { ApiKeysRepository } from '@/domain/repositories/api-keys-repository'
import type { AuditLogRepository } from '@/domain/repositories/audit-log-repository'
import type { DataSubjectKeysRepository } from '@/domain/repositories/data-subject-keys-repository'
import type { OutboxRepository } from '@/domain/repositories/outbox-repository'
import type { TenantsRepository } from '@/domain/repositories/tenants-repository'
import type { UsersRepository } from '@/domain/repositories/users-repository'

/** Every repository, bound to one transaction under one tenant. */
export interface TenantScope {
  readonly tenantId: string
  readonly tenants: TenantsRepository
  readonly users: UsersRepository
  readonly apiKeys: ApiKeysRepository
  readonly dataSubjectKeys: DataSubjectKeysRepository
  readonly audit: AuditLogRepository
  readonly outbox: OutboxRepository
}

/**
 * The one way to reach the database (ADR 0017).
 *
 * `inTenant` opens a transaction, issues `SET LOCAL app.current_tenant` before any other
 * statement, and hands the callback repositories bound to it. There is no other entry
 * point, and the Drizzle client the implementation builds is **not exported from the
 * module that constructs it** — so a repository has no reachable path to an unscoped
 * connection. Not discouraged: unreachable.
 *
 * `SET LOCAL` is transaction-scoped, so a pooled connection cannot carry one request's
 * tenant into the next. If `app.current_tenant` is unset, `current_setting` raises and
 * every query fails — deliberately. No tenant context means no data, never all data.
 *
 * **The transaction commits unless the callback throws.** A use case returning a `left`
 * still commits, which is what the reuse-detection path needs: the security audit entry
 * must survive the refusal that produced it. A fault throws, and nothing is written.
 */
export abstract class UnitOfWork {
  abstract inTenant<T>(tenantId: string, work: (scope: TenantScope) => Promise<T>): Promise<T>
}
