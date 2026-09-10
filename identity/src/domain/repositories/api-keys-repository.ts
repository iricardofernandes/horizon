import type { Page, PaginationParams } from '@/core/repositories/pagination-params'
import type { ApiKey } from '@/domain/entities/api-key'

export abstract class ApiKeysRepository {
  abstract findById(id: string): Promise<ApiKey | null>

  /** One indexed equality on the plaintext prefix, before any Argon2id cost (ADR 0022). */
  abstract findByPrefix(prefix: string): Promise<ApiKey | null>

  abstract create(apiKey: ApiKey): Promise<void>
  abstract save(apiKey: ApiKey): Promise<void>
  abstract list(params: PaginationParams): Promise<Page<ApiKey>>
  abstract listIssuedBy(userId: string): Promise<readonly ApiKey[]>
}
