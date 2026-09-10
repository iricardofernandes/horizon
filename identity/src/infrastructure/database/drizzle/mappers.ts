import type { Either } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ApiKey } from '@/domain/entities/api-key'
import { DataSubjectKey } from '@/domain/entities/data-subject-key'
import { Tenant } from '@/domain/entities/tenant'
import { ApiKeyScopes } from '@/domain/value-objects/api-key-scopes'
import { TenantName } from '@/domain/value-objects/tenant-name'
import { TenantSlug } from '@/domain/value-objects/tenant-slug'
import { Timezone } from '@/domain/value-objects/timezone'
import type { apiKeys, dataSubjectKeys, tenants } from './schema'

export function restored<E, T>(result: Either<E, T>): T {
  if (result.isLeft()) throw new Error('Invalid persisted domain value', { cause: result.value })
  return result.value
}

export function mapTenant(row: typeof tenants.$inferSelect): Tenant {
  if (row.status !== 'active' && row.status !== 'suspended')
    throw new Error('Invalid tenant status')
  return Tenant.create(
    {
      name: restored(TenantName.create(row.name)),
      slug: restored(TenantSlug.create(row.slug)),
      timezone: restored(Timezone.create(row.timezone)),
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    new UniqueEntityID(row.id),
  )
}

export function mapDataSubjectKey(row: typeof dataSubjectKeys.$inferSelect): DataSubjectKey {
  return DataSubjectKey.create(
    {
      tenantId: row.tenantId,
      material: row.material,
      createdAt: row.createdAt,
      ...(row.erasedAt === null ? {} : { erasedAt: row.erasedAt }),
    },
    new UniqueEntityID(row.id),
  )
}

export function mapApiKey(row: typeof apiKeys.$inferSelect): ApiKey {
  if (row.status !== 'active' && row.status !== 'revoked') throw new Error('Invalid API key status')
  return ApiKey.create(
    {
      tenantId: row.tenantId,
      issuedBy: row.issuedBy,
      name: row.name,
      environment: row.environment,
      prefix: row.prefix,
      secretHash: row.secretHash,
      scopes: restored(ApiKeyScopes.create(row.scopes)),
      status: row.status,
      createdAt: row.createdAt,
      ...(row.expiresAt === null ? {} : { expiresAt: row.expiresAt }),
      ...(row.lastUsedAt === null ? {} : { lastUsedAt: row.lastUsedAt }),
      ...(row.revokedAt === null ? {} : { revokedAt: row.revokedAt }),
      ...(row.supersededAt === null ? {} : { supersededAt: row.supersededAt }),
    },
    new UniqueEntityID(row.id),
  )
}
