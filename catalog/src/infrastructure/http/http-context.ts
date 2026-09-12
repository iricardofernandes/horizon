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
