import { createHash } from 'node:crypto'
import {
  type FiscalServiceIssuancePolicy,
  fiscalServiceIssuancePolicyRequestSchema,
} from '@horizon/contracts'
import postgres from 'postgres'
import { z } from 'zod'
import { appendAudit } from '../audit'

export type IssuanceMode = FiscalServiceIssuancePolicy['mode']

const setSchema = z.strictObject({
  tenantId: z.uuid(),
  establishmentId: z.uuid(),
  actorId: z.string().min(1).max(200),
  request: fiscalServiceIssuancePolicyRequestSchema,
})

/**
 * How an establishment issues the NFS-e of services delivered in Sales (ADR 0056):
 * `review` leaves each draft for a person, `automatic` validates and issues it at once.
 * Nothing configured means `review` on series 1, so no NFS-e is ever sent unasked.
 */
export class FiscalServiceIssuancePolicies {
  readonly #db: ReturnType<typeof postgres>

  constructor(databaseUrl: string) {
    this.#db = postgres(databaseUrl, { max: 3, connection: { statement_timeout: 5000 } })
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  async read(tenantId: string, establishmentId: string): Promise<FiscalServiceIssuancePolicy> {
    z.uuid().parse(tenantId)
    z.uuid().parse(establishmentId)
    const [row] = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select mode, series, updated_by, updated_at from fiscal_service_issuance_policies
        where tenant_id = ${tenantId} and establishment_id = ${establishmentId}`
    })
    if (!row)
      return {
        establishmentId,
        mode: 'review',
        series: 1,
        configured: false,
        updatedBy: null,
        updatedAt: null,
      }
    return {
      establishmentId,
      mode: z.enum(['review', 'automatic']).parse(row.mode),
      series: Number(row.series),
      configured: true,
      updatedBy: String(row.updated_by),
      updatedAt: new Date(row.updated_at).toISOString(),
    }
  }

  async set(input: z.input<typeof setSchema>): Promise<FiscalServiceIssuancePolicy> {
    const command = setSchema.parse(input)
    const { request } = command
    const reasonDigest = createHash('sha256').update(request.reason).digest('hex')
    await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${command.tenantId}, true)`
      await tx`insert into fiscal_service_issuance_policies (
          tenant_id, establishment_id, mode, series, reason_digest, updated_by
        ) values (
          ${command.tenantId}, ${command.establishmentId}, ${request.mode}, ${request.series},
          ${reasonDigest}, ${command.actorId}
        ) on conflict (tenant_id, establishment_id) do update set
          mode = excluded.mode, series = excluded.series,
          reason_digest = excluded.reason_digest, updated_by = excluded.updated_by,
          updated_at = now()`
      await appendAudit(tx, {
        tenantId: command.tenantId,
        actorId: command.actorId,
        action: 'service-issuance-policy.set',
        resourceId: command.establishmentId,
        detail: { mode: request.mode, series: request.series, reasonDigest },
      })
    })
    return this.read(command.tenantId, command.establishmentId)
  }
}
