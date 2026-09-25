import postgres from 'postgres'
import { z } from 'zod'
import type { FiscalArtifacts } from './artifacts'
import type { HomologationObservations } from './homologation-observations'

/** Reads every immutable authority artifact after a database and object-store restore. */
export class HomologationRestoreVerifier {
  readonly #db: ReturnType<typeof postgres>

  constructor(
    databaseUrl: string,
    private readonly artifacts: Pick<FiscalArtifacts, 'getV2' | 'listV2'>,
    private readonly observations: Pick<HomologationObservations, 'list'>,
  ) {
    this.#db = postgres(databaseUrl, { max: 5, connection: { statement_timeout: 5000 } })
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  async verify(
    tenantId: string,
    documentId: string,
  ): Promise<{
    documentId: string
    exchanges: number
    artifacts: number
    digests: string[]
  }> {
    z.uuid().parse(tenantId)
    z.uuid().parse(documentId)
    const [document] = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select environment from fiscal_documents
        where tenant_id = ${tenantId} and id = ${documentId}`
    })
    if (document?.environment !== 'homologation')
      throw new Error('Homologation restore document is unavailable')
    const exchanges = await this.observations.list(tenantId, documentId)
    if (exchanges.length === 0) throw new Error('Homologation restore has no exchange evidence')
    const [binding] = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select signed_xml_digest, schema_digest, request_digest
        from fiscal_homologation_authorization_bindings
        where tenant_id = ${tenantId} and document_id = ${documentId}`
    })
    const checks: Array<{
      kind: 'homologation_request' | 'homologation_response' | 'homologation_protocol' | 'danfe'
      digest: string
      sourceSchema: string
    }> = []
    for (const exchange of exchanges) {
      checks.push({
        kind: 'homologation_request',
        digest: exchange.requestDigest,
        sourceSchema: 'sefaz-nfe400-soap12-request',
      })
      if (exchange.responseDigest)
        checks.push({
          kind: 'homologation_response',
          digest: exchange.responseDigest,
          sourceSchema: 'sefaz-nfe400-soap12-response',
        })
      if (exchange.protocolDigest)
        checks.push({
          kind: 'homologation_protocol',
          digest: exchange.protocolDigest,
          sourceSchema: 'sefaz-nfe400-protocol',
        })
    }
    if (exchanges.some((exchange) => exchange.service === 'authorization')) {
      if (!binding) throw new Error('Homologation signed authorization binding is missing')
      if (
        !exchanges.some(
          (exchange) =>
            exchange.service === 'authorization' &&
            exchange.requestDigest === binding.request_digest,
        )
      )
        throw new Error('Homologation signed authorization request differs from exchange')
      checks.push({
        kind: 'homologation_request',
        digest: String(binding.signed_xml_digest),
        sourceSchema: `sefaz-nfe400-signed-document:${binding.schema_digest}`,
      })
    }
    const listed = await this.artifacts.listV2(tenantId, documentId)
    if (listed?.environment !== 'homologation')
      throw new Error('Homologation restore artifact list is unavailable')
    for (const artifact of listed.artifacts)
      if (artifact.kind === 'danfe')
        checks.push({
          kind: 'danfe',
          digest: artifact.digest,
          sourceSchema: 'horizon-danfe-homologation-v1',
        })
    const unique = [
      ...new Map(checks.map((check) => [`${check.kind}:${check.digest}`, check])).values(),
    ]
    for (const check of unique) {
      const artifact = await this.artifacts.getV2(tenantId, documentId, check.kind, check.digest)
      if (
        artifact.metadata.environment !== 'homologation' ||
        artifact.metadata.sourceSchema !== check.sourceSchema
      )
        throw new Error('Restored homologation artifact purpose differs from ledger')
    }
    return {
      documentId,
      exchanges: exchanges.length,
      artifacts: unique.length,
      digests: unique.map((check) => check.digest).sort(),
    }
  }
}
