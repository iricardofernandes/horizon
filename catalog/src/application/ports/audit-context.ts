import type { Actor } from '@/domain/audit/audit-entry'

/**
 * Who acted, and through which request.
 *
 * Every write use case takes it, which is deliberate: an audit entry written without a
 * named actor is a record that something happened and nothing more. The correlation
 * identifiers are optional because a scheduled job or a consumed event has no HTTP
 * request behind it — the actor is not.
 */
export interface AuditContext {
  readonly actor: Actor
  readonly requestId?: string | null
  readonly traceId?: string | null
  readonly sourceIp?: string | null
}

export function auditContext(context: AuditContext) {
  return {
    actor: context.actor,
    requestId: context.requestId ?? null,
    traceId: context.traceId ?? null,
    sourceIp: context.sourceIp ?? null,
  }
}
