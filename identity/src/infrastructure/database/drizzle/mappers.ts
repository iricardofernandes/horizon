import type { Either } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ApiKey } from '@/domain/entities/api-key'
import { DataSubjectKey } from '@/domain/entities/data-subject-key'
import { Tenant } from '@/domain/entities/tenant'
import { ApiKeyScopes } from '@/domain/value-objects/api-key-scopes'
import { CompanyProfile, FISCAL_REGIMES } from '@/domain/value-objects/company-profile'
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
      company: mapCompanyProfile(row),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    new UniqueEntityID(row.id),
  )
}

/** A workspace has no company profile until someone describes one. */
function mapCompanyProfile(row: typeof tenants.$inferSelect): CompanyProfile | null {
  if (row.legalName === null) return null
  const regime = FISCAL_REGIMES.find((known) => known === row.fiscalRegime)
  if (regime === undefined) throw new Error('Invalid fiscal regime')
  return restored(
    CompanyProfile.create({
      legalName: row.legalName,
      tradeName: row.tradeName,
      taxId: row.taxId,
      stateRegistration: row.stateRegistration,
      municipalRegistration: row.municipalRegistration,
      addressLine: row.addressLine,
      addressCity: row.addressCity,
      addressState: row.addressState,
      addressPostalCode: row.addressPostalCode,
      addressCountry: row.addressCountry,
      baseCurrency: row.baseCurrency,
      fiscalRegime: regime,
    }),
  )
}

/** The inverse: a tenant snapshot flattened into the columns the table actually has. */
export function tenantRow(tenant: Tenant): typeof tenants.$inferInsert {
  const snapshot = tenant.toSnapshot()
  const company = snapshot.company
  return {
    id: snapshot.id,
    name: snapshot.name,
    slug: snapshot.slug,
    timezone: snapshot.timezone,
    status: snapshot.status,
    legalName: company?.legalName ?? null,
    tradeName: company?.tradeName ?? null,
    taxId: company?.taxId ?? null,
    stateRegistration: company?.stateRegistration ?? null,
    municipalRegistration: company?.municipalRegistration ?? null,
    addressLine: company?.address.line ?? null,
    addressCity: company?.address.city ?? null,
    addressState: company?.address.state ?? null,
    addressPostalCode: company?.address.postalCode ?? null,
    addressCountry: company?.address.country ?? 'BR',
    baseCurrency: company?.baseCurrency ?? 'BRL',
    fiscalRegime: company?.fiscalRegime ?? 'not-declared',
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
  }
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
