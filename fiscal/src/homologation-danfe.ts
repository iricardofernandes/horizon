import postgres from 'postgres'
import { z } from 'zod'
import type { FiscalArtifacts } from './artifacts'
import { renderHomologationDanfe } from './nfe55/danfe'

/** Renders a non-fiscal homologation PDF only from a retained authorized protocol. */
export class HomologationDanfe {
  readonly #db: ReturnType<typeof postgres>

  constructor(
    databaseUrl: string,
    private readonly artifacts: Pick<FiscalArtifacts, 'getV2' | 'put'>,
  ) {
    this.#db = postgres(databaseUrl, { max: 5, connection: { statement_timeout: 5000 } })
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  async render(
    tenantId: string,
    documentId: string,
  ): Promise<{ digest: string; exchangeId: string }> {
    z.uuid().parse(tenantId)
    z.uuid().parse(documentId)
    const rows = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select observed.id, binding.signed_xml_digest, binding.schema_digest,
          parsed.protocol_digest
        from fiscal_homologation_authorization_bindings binding
        join fiscal_homologation_exchanges auth_exchange
          on auth_exchange.tenant_id = binding.tenant_id
          and auth_exchange.document_id = binding.document_id
          and auth_exchange.service = 'authorization'
          and auth_exchange.access_key = binding.access_key
        join fiscal_homologation_exchanges observed
          on observed.tenant_id = auth_exchange.tenant_id
          and (observed.id = auth_exchange.id
            or observed.parent_exchange_id = auth_exchange.id)
          and observed.service in ('authorization', 'receipt', 'protocol')
        join fiscal_homologation_parsed_responses parsed
          on parsed.tenant_id = observed.tenant_id and parsed.exchange_id = observed.id
          and parsed.decision = 'authorized' and parsed.protocol_digest is not null
        join fiscal_documents document
          on document.tenant_id = binding.tenant_id and document.id = binding.document_id
          and document.environment = 'homologation'
        where binding.tenant_id = ${tenantId} and binding.document_id = ${documentId}
        order by observed.prepared_at, observed.id`
    })
    const protocols = [...new Set(rows.map((row) => String(row.protocol_digest)))]
    if (protocols.length !== 1 || !rows[0])
      throw new Error('Unique authorized homologation protocol is unavailable for DANFE')
    const row = rows[0]
    const [signed, protocol] = await Promise.all([
      this.artifacts.getV2(
        tenantId,
        documentId,
        'homologation_request',
        String(row.signed_xml_digest),
      ),
      this.artifacts.getV2(tenantId, documentId, 'homologation_protocol', protocols[0] as string),
    ])
    if (
      signed.metadata.environment !== 'homologation' ||
      signed.metadata.sourceSchema !== `sefaz-nfe400-signed-document:${row.schema_digest}` ||
      protocol.metadata.environment !== 'homologation' ||
      protocol.metadata.sourceSchema !== 'sefaz-nfe400-protocol'
    )
      throw new Error('Homologation DANFE source artifacts have another purpose')
    const pdf = await renderHomologationDanfe({
      signedXml: signed.bytes,
      protocol: protocol.bytes,
    })
    const artifact = await this.artifacts.put(
      {
        tenantId,
        documentId,
        kind: 'danfe',
        mediaType: 'application/pdf',
        sourceSchema: 'horizon-danfe-homologation-v1',
      },
      pdf,
    )
    return { digest: artifact.digest, exchangeId: String(row.id) }
  }
}
