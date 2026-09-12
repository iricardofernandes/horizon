import { context as activeContext, trace } from '@opentelemetry/api'
import type { Actor } from '@/domain/audit/audit-entry'
import type { VerifiedAccessToken } from '@/infrastructure/cryptography/jwks-access-token-verifier'

export interface CatalogHttpRequest {
  method: string
  url: string
  originalUrl?: string
  headers: Record<string, string | string[] | undefined>
  ip?: string
  id?: string
  principal?: VerifiedAccessToken
}

/**
 * The tenant comes from the verified `tenant_id` claim and from nowhere else. A header
 * a client can set is not authority, even behind Kong (ADR 0008, ADR 0017).
 */
export function principal(request: CatalogHttpRequest): VerifiedAccessToken {
  if (request.principal === undefined) throw new Error('Authentication context is missing')
  return request.principal
}

export function tenantOf(request: CatalogHttpRequest): string {
  return principal(request).tenantId
}

/**
 * Catalog authenticates bearer tokens only. Identity mints them for a person, including
 * when an API key was exchanged for one, so the actor recorded here is that person —
 * which is the identity an auditor needs. A module that later authenticates a key
 * directly owes the 'api-key' actor type at that point.
 */
export function actor(request: CatalogHttpRequest): Actor {
  return { type: 'user', id: principal(request).subject }
}

/** The actor plus what ties the entry to a log line, a trace and a caller. */
export function auditOf(request: CatalogHttpRequest) {
  return {
    actor: actor(request),
    requestId: request.id ?? null,
    traceId: trace.getSpan(activeContext.active())?.spanContext().traceId ?? null,
    sourceIp: request.ip ?? null,
  }
}
