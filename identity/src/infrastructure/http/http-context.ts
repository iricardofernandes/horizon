import type { VerifiedAccessToken } from '@/application/ports/access-token-signer'
import type { Actor } from '@/domain/audit/audit-entry'

export interface IdentityHttpRequest {
  method: string
  url: string
  originalUrl?: string
  headers: Record<string, string | string[] | undefined>
  ip?: string
  id?: string
  principal?: VerifiedAccessToken
}

export function principal(request: IdentityHttpRequest): VerifiedAccessToken {
  if (request.principal === undefined) throw new Error('Authentication context is missing')
  return request.principal
}

export function actor(request: IdentityHttpRequest): Actor {
  return { type: 'user', id: principal(request).subject }
}

export function requestMetadata(request: IdentityHttpRequest) {
  return { sourceIp: request.ip ?? null, requestId: request.id ?? null }
}
