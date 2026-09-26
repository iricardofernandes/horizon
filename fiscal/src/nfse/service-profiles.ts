import { createHash } from 'node:crypto'
import {
  type FiscalServiceProfile,
  fiscalServiceProfileRequestSchema,
  fiscalServiceProfileSchema,
} from '@horizon/contracts'
import postgres from 'postgres'
import { z } from 'zod'
import { appendAudit } from '../audit'
import type { OwnerFiscalClient } from '../backfill'
import { canonicalDigest } from '../canonical-json'
import { nationalServiceDescription, nbsDescription } from './reference'

const commandSchema = z.strictObject({
  tenantId: z.uuid(),
  actorId: z.string().min(1).max(200),
  request: fiscalServiceProfileRequestSchema,
})
const catalogServiceSchema = z.object({
  id: z.uuid(),
  kind: z.literal('service'),
  active: z.literal(true),
})

/**
 * The service fiscal profile: the service counterpart of the goods classification.
 * Revisions are immutable and effective-dated; a document keeps the revision it froze.
 */
export class FiscalServiceProfiles {
  readonly #db: ReturnType<typeof postgres>

  constructor(
    databaseUrl: string,
    private readonly ownerForTenant: (tenantId: string) => Pick<OwnerFiscalClient, 'catalogItem'>,
  ) {
    this.#db = postgres(databaseUrl, { max: 5, connection: { statement_timeout: 5000 } })
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  /** Appends a revision; resending the latest revision's facts returns it unchanged. */
  async create(
    input: z.input<typeof commandSchema>,
  ): Promise<FiscalServiceProfile & { existing: boolean }> {
    const command = commandSchema.parse(input)
    const { request } = command
    if (!nationalServiceDescription(request.nationalTaxCode))
      throw new Error('Service national tax code is not in the national service list')
    if (!nbsDescription(request.nbsCode)) throw new Error('Service NBS code is not in NBS 2.0')
    const item = catalogServiceSchema.safeParse(
      await this.ownerForTenant(command.tenantId).catalogItem(request.itemId),
    )
    if (!item.success || item.data.id !== request.itemId)
      throw new Error('Service profile needs an active Catalog service item')
    const facts = {
      itemId: request.itemId,
      nationalTaxCode: request.nationalTaxCode,
      nbsCode: request.nbsCode,
      municipalTaxCode: request.municipalTaxCode ?? null,
      issTaxation: request.issTaxation,
      description: request.description,
      effectiveFrom: request.effectiveFrom,
    }
    const digest = canonicalDigest(facts)
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${command.tenantId}, true)`
      await tx`select pg_advisory_xact_lock(hashtextextended(${`${command.tenantId}:service-profile:${request.itemId}`}, 0))`
      const [latest] = await tx`select * from fiscal_service_profiles
        where tenant_id = ${command.tenantId} and item_id = ${request.itemId}
        order by revision desc limit 1`
      if (latest?.digest === digest) return { ...toProfile(latest), existing: true }
      const revision = latest ? Number(latest.revision) + 1 : 1
      const [saved] = await tx`insert into fiscal_service_profiles (
          tenant_id, item_id, revision, national_tax_code, nbs_code, municipal_tax_code,
          iss_taxation, description, effective_from, reason_digest, digest, created_by
        ) values (
          ${command.tenantId}, ${request.itemId}, ${revision}, ${facts.nationalTaxCode},
          ${facts.nbsCode}, ${facts.municipalTaxCode}, ${facts.issTaxation},
          ${facts.description}, ${facts.effectiveFrom},
          ${createHash('sha256').update(request.reason).digest('hex')}, ${digest},
          ${command.actorId}
        ) returning *`
      if (!saved) throw new Error('Service profile was not saved')
      await appendAudit(tx, {
        tenantId: command.tenantId,
        actorId: command.actorId,
        action: 'service-profile.revised',
        resourceId: request.itemId,
        detail: { revision, digest },
      })
      return { ...toProfile(saved), existing: false }
    })
  }

  async list(tenantId: string, itemId: string): Promise<FiscalServiceProfile[]> {
    z.uuid().parse(tenantId)
    z.uuid().parse(itemId)
    const rows = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select * from fiscal_service_profiles
        where tenant_id = ${tenantId} and item_id = ${itemId} order by revision`
    })
    return rows.map(toProfile)
  }

  /** The exact revision a service origin froze. */
  async read(
    tenantId: string,
    itemId: string,
    revision: number,
  ): Promise<FiscalServiceProfile | null> {
    const rows = await this.list(tenantId, itemId)
    return rows.find((row) => row.revision === revision) ?? null
  }

  /** The revision in force on a competence date: the latest effective on or before it. */
  async effective(
    tenantId: string,
    itemId: string,
    competenceDate: string,
  ): Promise<FiscalServiceProfile | null> {
    const rows = await this.list(tenantId, itemId)
    const candidates = rows.filter((row) => row.effectiveFrom <= competenceDate)
    return candidates.at(-1) ?? null
  }
}

function toProfile(row: postgres.Row): FiscalServiceProfile {
  return fiscalServiceProfileSchema.parse({
    itemId: String(row.item_id),
    revision: Number(row.revision),
    nationalTaxCode: String(row.national_tax_code),
    nbsCode: String(row.nbs_code),
    municipalTaxCode: row.municipal_tax_code === null ? null : String(row.municipal_tax_code),
    issTaxation: String(row.iss_taxation),
    description: String(row.description),
    effectiveFrom: isoDate(row.effective_from),
    digest: String(row.digest),
    createdBy: String(row.created_by),
    createdAt: new Date(row.created_at).toISOString(),
  })
}

export function isoDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value).slice(0, 10)
}
