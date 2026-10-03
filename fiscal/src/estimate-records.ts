import {
  type FiscalTaxEstimate,
  type FiscalTaxEstimateRecord,
  type FiscalTaxEstimateRequest,
  fiscalTaxEstimateRecordSchema,
} from '@horizon/contracts'
import postgres from 'postgres'
import { z } from 'zod'

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/)

/**
 * Every estimate Fiscal issues, kept with the request it answered (Phase 91, ADR 0076). Sales
 * and Procurement keep an estimate only once it is read back from here, and Fiscal compares a
 * supplier's NF-e only with an estimate found here. A record never changes.
 */
export class FiscalEstimateRecords {
  readonly #db: ReturnType<typeof postgres>

  constructor(databaseUrl: string) {
    this.#db = postgres(databaseUrl, { max: 5, connection: { statement_timeout: 10_000 } })
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  async keep(
    tenantId: string,
    request: FiscalTaxEstimateRequest,
    estimate: Extract<FiscalTaxEstimate, { supported: true }>,
  ): Promise<void> {
    z.uuid().parse(tenantId)
    await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      await tx`insert into fiscal_tax_estimates
          (tenant_id, result_digest, direction, request, estimate, estimated_at)
        values (${tenantId}, ${estimate.resultDigest}, ${request.direction},
          ${tx.json(request as postgres.JSONValue)}, ${tx.json(estimate as postgres.JSONValue)},
          ${estimate.estimatedAt})
        on conflict do nothing`
    })
  }

  async find(tenantId: string, resultDigest: string): Promise<FiscalTaxEstimateRecord | null> {
    z.uuid().parse(tenantId)
    digestSchema.parse(resultDigest)
    const [row] = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select request, estimate from fiscal_tax_estimates
        where tenant_id = ${tenantId} and result_digest = ${resultDigest}`
    })
    return row
      ? fiscalTaxEstimateRecordSchema.parse({ request: row.request, estimate: row.estimate })
      : null
  }
}

/**
 * The record of an estimate, read inside a transaction already scoped to the tenant: what a
 * projection uses to trust a digest another module carried.
 */
export async function issuedEstimate(
  tx: postgres.TransactionSql,
  tenantId: string,
  resultDigest: string,
): Promise<FiscalTaxEstimateRecord | null> {
  const [row] = await tx`select request, estimate from fiscal_tax_estimates
    where tenant_id = ${tenantId} and result_digest = ${resultDigest}`
  return row
    ? fiscalTaxEstimateRecordSchema.parse({ request: row.request, estimate: row.estimate })
    : null
}
