import { type FiscalTaxEstimateRecord, fiscalTaxEstimateRecordSchema } from '@horizon/contracts'

export type IssuedEstimate =
  | { readonly status: 'found'; readonly record: FiscalTaxEstimateRecord }
  | { readonly status: 'not-issued' }
  | { readonly status: 'forbidden' }
  | { readonly status: 'unavailable' }

/**
 * Reads an estimate back from Fiscal by its digest, through the gateway, with the caller's
 * token (Phase 91, ADR 0076). What a browser relays is never kept: only what Fiscal answers.
 * The token is never stored or logged, and Procurement holds no access of its own to Fiscal.
 */
export class GatewayFiscalEstimates {
  constructor(
    private readonly gatewayUrl: string,
    private readonly timeoutMs = 10_000,
  ) {}

  async find(resultDigest: string, bearer: string): Promise<IssuedEstimate> {
    if (!/^[0-9a-f]{64}$/.test(resultDigest)) return { status: 'not-issued' }
    let response: Response
    try {
      response = await fetch(new URL(`/fiscal/estimates/${resultDigest}`, this.gatewayUrl), {
        headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch {
      return { status: 'unavailable' }
    }
    if (response.status === 404) return { status: 'not-issued' }
    if (response.status === 401 || response.status === 403) return { status: 'forbidden' }
    if (!response.ok) return { status: 'unavailable' }
    try {
      const record = fiscalTaxEstimateRecordSchema.parse(await response.json())
      // The answer must be the estimate that was asked for, whatever answered.
      return record.estimate.resultDigest === resultDigest
        ? { status: 'found', record }
        : { status: 'unavailable' }
    } catch {
      return { status: 'unavailable' }
    }
  }
}
