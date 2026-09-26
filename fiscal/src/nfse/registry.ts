import { createHash, randomUUID } from 'node:crypto'
import {
  type FiscalNfseMunicipalityResolution,
  type FiscalNfseRegistryEntry,
  type FiscalNfseRegistryVersion,
  fiscalNfseMunicipalityResolutionSchema,
  fiscalNfseRegistryEntrySchema,
  fiscalNfseRegistryVersionRequestSchema,
} from '@horizon/contracts'
import postgres from 'postgres'
import { z } from 'zod'
import { appendAudit } from '../audit'
import { canonicalDigest } from '../canonical-json'
import { ibgeMunicipality } from './reference'
import { isoDate } from './service-profiles'

const importSchema = z.strictObject({
  tenantId: z.uuid(),
  actorId: z.string().min(1).max(200),
  request: fiscalNfseRegistryVersionRequestSchema,
})
const reviewSchema = z.strictObject({
  tenantId: z.uuid(),
  versionId: z.uuid(),
  actorId: z.string().min(1).max(200),
  interpretation: z.string().trim().min(10).max(1000),
})

/**
 * The versioned NFS-e municipal registry. A municipality is issued by the national
 * system only when the latest reviewed version says so for the competence date; a
 * missing municipality or an unreviewed version is never support.
 */
export class FiscalNfseRegistry {
  readonly #db: ReturnType<typeof postgres>

  constructor(databaseUrl: string) {
    this.#db = postgres(databaseUrl, { max: 5, connection: { statement_timeout: 10_000 } })
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  async importVersion(input: z.input<typeof importSchema>): Promise<FiscalNfseRegistryVersion> {
    const command = importSchema.parse(input)
    const { request } = command
    const seen = new Set<string>()
    for (const entry of request.entries) {
      if (seen.has(entry.municipalityCode)) throw new Error('Duplicate NFS-e registry municipality')
      seen.add(entry.municipalityCode)
      const reference = ibgeMunicipality(entry.municipalityCode)
      if (!reference || reference.uf !== entry.uf)
        throw new Error('NFS-e registry municipality is not in the IBGE table (Anexo A)')
    }
    const entries = [...request.entries].sort((left, right) =>
      left.municipalityCode.localeCompare(right.municipalityCode),
    )
    const digest = canonicalDigest({
      sourceUri: request.sourceUri,
      sourceDigest: request.sourceDigest,
      publishedOn: request.publishedOn,
      entries,
    })
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${command.tenantId}, true)`
      await tx`select pg_advisory_xact_lock(hashtextextended(${`${command.tenantId}:nfse-registry:${digest}`}, 0))`
      const [prior] = await tx`select id from fiscal_nfse_registry_versions
        where tenant_id = ${command.tenantId} and digest = ${digest}`
      if (prior) return this.readVersion(tx, command.tenantId, String(prior.id), true)
      const id = randomUUID()
      await tx`insert into fiscal_nfse_registry_versions (
          id, tenant_id, source_uri, source_digest, published_on, entry_count, digest, imported_by
        ) values (
          ${id}, ${command.tenantId}, ${request.sourceUri}, ${request.sourceDigest},
          ${request.publishedOn}, ${entries.length}, ${digest}, ${command.actorId}
        )`
      for (const entry of entries)
        await tx`insert into fiscal_nfse_registry_entries (
            tenant_id, version_id, municipality_code, uf, name, agreement,
            national_environment, national_issuer, starts_on, source_locator
          ) values (
            ${command.tenantId}, ${id}, ${entry.municipalityCode}, ${entry.uf}, ${entry.name},
            ${entry.agreement}, ${entry.nationalEnvironment}, ${entry.nationalIssuer},
            ${entry.startsOn}, ${entry.sourceLocator}
          )`
      await appendAudit(tx, {
        tenantId: command.tenantId,
        actorId: command.actorId,
        action: 'nfse-registry.imported',
        resourceId: id,
        detail: { digest, sourceDigest: request.sourceDigest, entries: entries.length },
      })
      return this.readVersion(tx, command.tenantId, id, false)
    })
  }

  async review(input: z.input<typeof reviewSchema>): Promise<FiscalNfseRegistryVersion> {
    const command = reviewSchema.parse(input)
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${command.tenantId}, true)`
      await tx`select pg_advisory_xact_lock(hashtextextended(${`${command.tenantId}:nfse-registry-review:${command.versionId}`}, 0))`
      const [version] = await tx`select imported_by from fiscal_nfse_registry_versions
        where tenant_id = ${command.tenantId} and id = ${command.versionId}`
      if (!version) throw new Error('NFS-e registry version not found')
      await tx`insert into fiscal_nfse_registry_reviews (
          tenant_id, version_id, reviewed_by, interpretation_digest
        ) values (
          ${command.tenantId}, ${command.versionId}, ${command.actorId},
          ${createHash('sha256').update(command.interpretation).digest('hex')}
        ) on conflict do nothing`
      await appendAudit(tx, {
        tenantId: command.tenantId,
        actorId: command.actorId,
        action: 'nfse-registry.reviewed',
        resourceId: command.versionId,
        detail: {},
      })
      return this.readVersion(tx, command.tenantId, command.versionId, false)
    })
  }

  /** Whether the national system issues for a municipality on a competence date. */
  async resolve(
    tenantId: string,
    municipalityCode: string,
    competenceDate: string,
  ): Promise<FiscalNfseMunicipalityResolution> {
    z.uuid().parse(tenantId)
    z.string()
      .regex(/^\d{7}$/)
      .parse(municipalityCode)
    z.iso.date().parse(competenceDate)
    const [row] = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select version.id as version_id, entry.municipality_code, entry.uf, entry.name,
          entry.agreement, entry.national_environment, entry.national_issuer,
          entry.starts_on::text as starts_on, entry.source_locator, version.published_on
        from fiscal_nfse_registry_versions version
        join fiscal_nfse_registry_reviews review on review.tenant_id = version.tenant_id
          and review.version_id = version.id
        left join fiscal_nfse_registry_entries entry on entry.tenant_id = version.tenant_id
          and entry.version_id = version.id and entry.municipality_code = ${municipalityCode}
        where version.tenant_id = ${tenantId}
        order by version.published_on desc, version.created_at desc limit 1`
    })
    const unsupported = (reason: string, entry: FiscalNfseRegistryEntry | null = null) =>
      fiscalNfseMunicipalityResolutionSchema.parse({
        municipalityCode,
        competenceDate,
        route: 'unsupported',
        reason,
        versionId: row ? String(row.version_id) : null,
        entry,
      })
    if (!row) return unsupported('No reviewed NFS-e registry version exists')
    if (!row.municipality_code)
      return unsupported('The reviewed registry version does not list this municipality')
    const entry = fiscalNfseRegistryEntrySchema.parse({
      municipalityCode: String(row.municipality_code),
      uf: String(row.uf),
      name: String(row.name),
      agreement: String(row.agreement),
      nationalEnvironment: Boolean(row.national_environment),
      nationalIssuer: Boolean(row.national_issuer),
      startsOn: row.starts_on === null ? null : String(row.starts_on),
      sourceLocator: String(row.source_locator),
    })
    if (entry.agreement !== 'active')
      return unsupported('The municipality agreement is not active (E0038)', entry)
    if (!entry.nationalIssuer)
      return unsupported(
        'The municipality does not use the national public issuer (E0039); it needs its own adapter',
        entry,
      )
    if (!entry.startsOn || competenceDate < entry.startsOn)
      return unsupported('The competence date precedes the agreement start (E0016)', entry)
    return fiscalNfseMunicipalityResolutionSchema.parse({
      municipalityCode,
      competenceDate,
      route: 'national',
      reason: null,
      versionId: String(row.version_id),
      entry,
    })
  }

  private async readVersion(
    tx: postgres.TransactionSql,
    tenantId: string,
    id: string,
    existing: boolean,
  ): Promise<FiscalNfseRegistryVersion> {
    const [row] = await tx`select version.*, review.reviewed_by, review.reviewed_at
      from fiscal_nfse_registry_versions version
      left join fiscal_nfse_registry_reviews review on review.tenant_id = version.tenant_id
        and review.version_id = version.id
      where version.tenant_id = ${tenantId} and version.id = ${id}`
    if (!row) throw new Error('NFS-e registry version not found')
    return {
      id,
      sourceUri: String(row.source_uri),
      sourceDigest: String(row.source_digest),
      publishedOn: isoDate(row.published_on),
      entryCount: Number(row.entry_count),
      digest: String(row.digest),
      reviewed: row.reviewed_by !== null,
      reviewedBy: row.reviewed_by === null ? null : String(row.reviewed_by),
      reviewedAt: row.reviewed_at === null ? null : new Date(row.reviewed_at).toISOString(),
      createdAt: new Date(row.created_at).toISOString(),
      existing,
    }
  }
}
