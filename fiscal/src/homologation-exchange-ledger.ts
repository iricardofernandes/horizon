import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { z } from 'zod'
import type { FiscalArtifacts } from './artifacts'
import { appendAudit } from './audit'
import type { PreparedSefazExchange } from './nfe55/sefaz-adapter'
import type { SefazResponse } from './nfe55/sefaz-soap'

const digest = z.string().regex(/^[0-9a-f]{64}$/)
const prepareSchema = z.strictObject({
  tenantId: z.uuid(),
  documentId: z.uuid(),
  exchangeId: z.uuid(),
  drillGrantId: z.uuid(),
  parentExchangeId: z.uuid().nullable(),
  endpointDigest: digest,
  wsdlDigest: digest,
  certificateFingerprint: digest,
  adapterVersion: z.string().min(1).max(160),
  actorId: z.string().min(1).max(200),
})
const grantSchema = z.strictObject({
  tenantId: z.uuid(),
  documentId: z.uuid(),
  grantId: z.uuid(),
  capabilityId: z.uuid(),
  endpointDigest: digest,
  wsdlDigest: digest,
  certificateFingerprint: digest,
  issuedBy: z.string().min(1).max(200),
  expiresAt: z.iso.datetime({ offset: true }),
})

/** Append-only evidence for internal SP homologation exchanges; no network I/O occurs here. */
export class HomologationExchangeLedger {
  readonly #db: ReturnType<typeof postgres>

  constructor(
    databaseUrl: string,
    private readonly artifacts: Pick<FiscalArtifacts, 'put' | 'get'>,
  ) {
    this.#db = postgres(databaseUrl, { max: 10, connection: { statement_timeout: 5000 } })
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  async grantDrill(input: z.input<typeof grantSchema>): Promise<void> {
    const value = grantSchema.parse(input)
    await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${value.tenantId}, true)`
      const inserted = await tx`insert into fiscal_homologation_drill_grants (
        id, tenant_id, capability_id, document_id, endpoint_digest, wsdl_digest,
        certificate_fingerprint, issued_by, expires_at
      ) values (
        ${value.grantId}, ${value.tenantId}, ${value.capabilityId}, ${value.documentId},
        ${value.endpointDigest}, ${value.wsdlDigest}, ${value.certificateFingerprint},
        ${value.issuedBy}, ${value.expiresAt}
      ) on conflict do nothing returning id`
      const [stored] = await tx`select capability_id, document_id, endpoint_digest,
          wsdl_digest, certificate_fingerprint, issued_by, expires_at
        from fiscal_homologation_drill_grants
        where tenant_id = ${value.tenantId} and id = ${value.grantId}`
      if (
        !stored ||
        stored.capability_id !== value.capabilityId ||
        stored.document_id !== value.documentId ||
        stored.endpoint_digest !== value.endpointDigest ||
        stored.wsdl_digest !== value.wsdlDigest ||
        stored.certificate_fingerprint !== value.certificateFingerprint ||
        stored.issued_by !== value.issuedBy ||
        new Date(stored.expires_at).toISOString() !== new Date(value.expiresAt).toISOString()
      )
        throw new Error('Conflicting immutable homologation drill grant')
      if (inserted.length > 0)
        await appendAudit(tx, {
          tenantId: value.tenantId,
          actorId: value.issuedBy,
          action: 'homologation.drill-granted',
          resourceId: value.documentId,
          detail: {
            grantId: value.grantId,
            capabilityId: value.capabilityId,
            endpointDigest: value.endpointDigest,
            certificateFingerprint: value.certificateFingerprint,
            expiresAt: value.expiresAt,
          },
        })
    })
  }

  async prepare(
    input: z.input<typeof prepareSchema>,
    exchange: PreparedSefazExchange,
  ): Promise<{ exchangeId: string; requestDigest: string }> {
    const value = prepareSchema.parse(input)
    const request = await this.artifacts.put(
      {
        tenantId: value.tenantId,
        documentId: value.documentId,
        kind: 'xml',
        mediaType: 'application/soap+xml',
        sourceSchema: 'sefaz-nfe400-soap12-request',
      },
      exchange.request,
    )
    await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${value.tenantId}, true)`
      const [document] = await tx`select environment from fiscal_documents
        where tenant_id = ${value.tenantId} and id = ${value.documentId}`
      if (document?.environment !== 'homologation')
        throw new Error('SEFAZ exchange requires a homologation document')
      if (value.parentExchangeId) {
        const [parent] = await tx`select document_id from fiscal_homologation_exchanges
          where tenant_id = ${value.tenantId} and id = ${value.parentExchangeId}`
        if (parent?.document_id !== value.documentId)
          throw new Error('SEFAZ consultation parent differs from document')
      }
      const inserted = await tx`insert into fiscal_homologation_exchanges (
        id, tenant_id, document_id, drill_grant_id, parent_exchange_id, service, request_digest,
        endpoint_digest, wsdl_digest, certificate_fingerprint, adapter_version,
        access_key, receipt
      ) values (
        ${value.exchangeId}, ${value.tenantId}, ${value.documentId}, ${value.drillGrantId},
        ${value.parentExchangeId}, ${exchange.service}, ${request.digest},
        ${value.endpointDigest}, ${value.wsdlDigest}, ${value.certificateFingerprint},
        ${value.adapterVersion}, ${exchange.expectedAccessKey ?? null},
        ${exchange.expectedReceipt ?? null}
      ) on conflict do nothing returning id`
      const [stored] = await tx`select document_id, drill_grant_id, parent_exchange_id, service,
          request_digest, endpoint_digest, wsdl_digest, certificate_fingerprint,
          adapter_version, access_key, receipt
        from fiscal_homologation_exchanges
        where tenant_id = ${value.tenantId} and id = ${value.exchangeId}`
      if (
        !stored ||
        stored.document_id !== value.documentId ||
        stored.drill_grant_id !== value.drillGrantId ||
        stored.parent_exchange_id !== value.parentExchangeId ||
        stored.service !== exchange.service ||
        stored.request_digest !== request.digest ||
        stored.endpoint_digest !== value.endpointDigest ||
        stored.wsdl_digest !== value.wsdlDigest ||
        stored.certificate_fingerprint !== value.certificateFingerprint ||
        stored.adapter_version !== value.adapterVersion ||
        stored.access_key !== (exchange.expectedAccessKey ?? null) ||
        stored.receipt !== (exchange.expectedReceipt ?? null)
      )
        throw new Error('Conflicting immutable SEFAZ exchange')
      if (inserted.length > 0)
        await appendAudit(tx, {
          tenantId: value.tenantId,
          actorId: value.actorId,
          action: 'homologation.exchange-prepared',
          resourceId: value.documentId,
          detail: {
            exchangeId: value.exchangeId,
            service: exchange.service,
            requestDigest: request.digest,
          },
        })
    })
    return { exchangeId: value.exchangeId, requestDigest: request.digest }
  }

  /** Only the worker that inserts this fact may send. A crash leaves it uncertain. */
  async markStarted(tenantId: string, exchangeId: string, workerId: string): Promise<boolean> {
    z.uuid().parse(tenantId)
    z.uuid().parse(exchangeId)
    z.string().min(1).max(200).parse(workerId)
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      const inserted = await tx`insert into fiscal_homologation_transmissions
        (tenant_id, exchange_id, worker_id)
        values (${tenantId}, ${exchangeId}, ${workerId})
        on conflict do nothing returning exchange_id`
      return inserted.length === 1
    })
  }

  async recordRawResponse(
    tenantId: string,
    documentId: string,
    exchangeId: string,
    bytes: Buffer,
  ): Promise<string> {
    z.uuid().parse(tenantId)
    z.uuid().parse(documentId)
    z.uuid().parse(exchangeId)
    const artifact = await this.artifacts.put(
      {
        tenantId,
        documentId,
        kind: 'response',
        mediaType: 'application/soap+xml',
        sourceSchema: 'sefaz-nfe400-soap12-response',
      },
      bytes,
    )
    await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      const [exchange] = await tx`select document_id from fiscal_homologation_exchanges
        where tenant_id = ${tenantId} and id = ${exchangeId}`
      if (exchange?.document_id !== documentId)
        throw new Error('SEFAZ response document differs from exchange')
      await tx`insert into fiscal_homologation_raw_responses
        (tenant_id, exchange_id, response_digest)
        values (${tenantId}, ${exchangeId}, ${artifact.digest}) on conflict do nothing`
      const [stored] = await tx`select response_digest from fiscal_homologation_raw_responses
        where tenant_id = ${tenantId} and exchange_id = ${exchangeId}`
      if (stored?.response_digest !== artifact.digest)
        throw new Error('Conflicting immutable SEFAZ response')
    })
    return artifact.digest
  }

  async recordParsedResponse(
    tenantId: string,
    documentId: string,
    exchangeId: string,
    response: SefazResponse,
  ): Promise<void> {
    z.uuid().parse(tenantId)
    z.uuid().parse(documentId)
    z.uuid().parse(exchangeId)
    const raw = await this.artifacts.get(
      tenantId,
      documentId,
      'response',
      await this.rawDigest(tenantId, exchangeId),
    )
    if (!raw.bytes.equals(response.response))
      throw new Error('Parsed SEFAZ response bytes differ from stored raw artifact')
    const protocol = response.protocol
      ? await this.artifacts.put(
          {
            tenantId,
            documentId,
            kind: 'protocol',
            mediaType: 'application/xml',
            sourceSchema: 'sefaz-nfe400-protocol',
          },
          response.protocol,
        )
      : null
    await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      const [exchange] = await tx`select document_id, service from fiscal_homologation_exchanges
        where tenant_id = ${tenantId} and id = ${exchangeId}`
      if (exchange?.document_id !== documentId || exchange.service !== response.service)
        throw new Error('Parsed SEFAZ response differs from exchange')
      await tx`insert into fiscal_homologation_parsed_responses (
        tenant_id, exchange_id, response_digest, protocol_digest, cstat,
        document_cstat, event_cstat, receipt, protocol_number
      ) values (
        ${tenantId}, ${exchangeId}, ${raw.metadata.digest}, ${protocol?.digest ?? null},
        ${response.statusCode}, ${response.documentStatusCode}, ${response.eventStatusCode},
        ${response.receipt}, ${response.protocolNumber}
      ) on conflict do nothing`
      const [stored] = await tx`select response_digest, protocol_digest, cstat,
          document_cstat, event_cstat, receipt, protocol_number
        from fiscal_homologation_parsed_responses
        where tenant_id = ${tenantId} and exchange_id = ${exchangeId}`
      if (
        !stored ||
        stored.response_digest !== raw.metadata.digest ||
        stored.protocol_digest !== (protocol?.digest ?? null) ||
        stored.cstat !== response.statusCode ||
        stored.document_cstat !== response.documentStatusCode ||
        stored.event_cstat !== response.eventStatusCode ||
        stored.receipt !== response.receipt ||
        stored.protocol_number !== response.protocolNumber
      )
        throw new Error('Conflicting parsed SEFAZ response')
    })
  }

  private async rawDigest(tenantId: string, exchangeId: string): Promise<string> {
    const [row] = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select response_digest from fiscal_homologation_raw_responses
        where tenant_id = ${tenantId} and exchange_id = ${exchangeId}`
    })
    if (!row) throw new Error('Raw SEFAZ response is unavailable')
    return String(row.response_digest)
  }
}

export function newHomologationExchangeId(): string {
  return randomUUID()
}
