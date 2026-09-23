import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { z } from 'zod'
import type { FiscalArtifacts } from './artifacts'
import { appendAudit } from './audit'
import type {
  PreparedSefazExchange,
  SefazExchangeInput,
  SefazNfe55HomologationAdapter,
  SefazOperationMap,
} from './nfe55/sefaz-adapter'
import { classifySefazResponse, SEFAZ_DECISION_VERSION } from './nfe55/sefaz-decision'
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

  /** Reopens exact stored request bytes; a started exchange must never be sent again. */
  async loadPrepared(
    tenantId: string,
    exchangeId: string,
    operations: SefazOperationMap,
    actorId: string,
  ): Promise<{
    input: z.infer<typeof prepareSchema>
    prepared: PreparedSefazExchange
    stage: 'prepared' | 'send_started' | 'raw_unparsed' | 'observed'
    rawResponse: Buffer | null
  }> {
    z.uuid().parse(tenantId)
    z.uuid().parse(exchangeId)
    const [row] = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select exchange.document_id, exchange.drill_grant_id,
          exchange.parent_exchange_id, exchange.service, exchange.request_digest,
          exchange.endpoint_digest, exchange.wsdl_digest,
          exchange.certificate_fingerprint, exchange.adapter_version,
          exchange.access_key, exchange.receipt, exchange.authorization_protocol,
          transmission.started_at, raw.response_digest, parsed.parsed_at
        from fiscal_homologation_exchanges exchange
        left join fiscal_homologation_transmissions transmission
          on transmission.tenant_id = exchange.tenant_id and transmission.exchange_id = exchange.id
        left join fiscal_homologation_raw_responses raw
          on raw.tenant_id = exchange.tenant_id and raw.exchange_id = exchange.id
        left join fiscal_homologation_parsed_responses parsed
          on parsed.tenant_id = exchange.tenant_id and parsed.exchange_id = exchange.id
        where exchange.tenant_id = ${tenantId} and exchange.id = ${exchangeId}`
    })
    if (!row) throw new Error('SEFAZ exchange not found')
    if (row.wsdl_digest !== operations.wsdlDigest)
      throw new Error('Stored SEFAZ exchange WSDL differs from reviewed operations')
    const service = z
      .enum(['authorization', 'receipt', 'protocol', 'status', 'event'])
      .parse(row.service)
    const operation = operations[service]
    if (!operation) throw new Error('Reviewed SEFAZ operation is unavailable')
    const documentId = String(row.document_id)
    const request = await this.artifacts.get(
      tenantId,
      documentId,
      'homologation_request',
      String(row.request_digest),
    )
    if (request.metadata.sourceSchema !== 'sefaz-nfe400-soap12-request')
      throw new Error('Stored SEFAZ request has another schema purpose')
    const rawResponse = row.response_digest
      ? (
          await this.artifacts.get(
            tenantId,
            documentId,
            'homologation_response',
            String(row.response_digest),
          )
        ).bytes
      : null
    return {
      input: prepareSchema.parse({
        tenantId,
        documentId,
        exchangeId,
        drillGrantId: row.drill_grant_id,
        parentExchangeId: row.parent_exchange_id,
        endpointDigest: row.endpoint_digest,
        wsdlDigest: row.wsdl_digest,
        certificateFingerprint: row.certificate_fingerprint,
        adapterVersion: row.adapter_version,
        actorId,
      }),
      prepared: {
        service,
        request: request.bytes,
        operation: operation.operation,
        operationNamespace: operation.operationNamespace,
        ...(row.access_key ? { expectedAccessKey: String(row.access_key) } : {}),
        ...(row.receipt ? { expectedReceipt: String(row.receipt) } : {}),
        ...(row.authorization_protocol
          ? { expectedAuthorizationProtocol: String(row.authorization_protocol) }
          : {}),
      },
      stage: row.parsed_at
        ? 'observed'
        : rawResponse
          ? 'raw_unparsed'
          : row.started_at
            ? 'send_started'
            : 'prepared',
      rawResponse,
    }
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

  async drillContext(
    tenantId: string,
    documentId: string,
    grantId: string,
  ): Promise<{
    drillGrantId: string
    endpointDigest: string
    wsdlDigest: string
    certificateFingerprint: string
    adapterVersion: string
  }> {
    z.uuid().parse(tenantId)
    z.uuid().parse(documentId)
    z.uuid().parse(grantId)
    const [row] = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select grant_row.endpoint_digest, grant_row.wsdl_digest,
          grant_row.certificate_fingerprint, definition.adapter_version
        from fiscal_homologation_drill_grants grant_row
        join fiscal_capability_definitions definition
          on definition.tenant_id = grant_row.tenant_id
          and definition.id = grant_row.capability_id
        where grant_row.tenant_id = ${tenantId} and grant_row.id = ${grantId}
          and grant_row.document_id = ${documentId} and grant_row.expires_at > now()
          and definition.environment = 'homologation' and definition.model = '55'
          and definition.jurisdiction_kind = 'uf' and definition.jurisdiction_code = 'SP'
          and definition.operation = 'normal-sale'`
    })
    if (!row) throw new Error('Approved SP homologation drill is unavailable')
    return {
      drillGrantId: grantId,
      endpointDigest: String(row.endpoint_digest),
      wsdlDigest: String(row.wsdl_digest),
      certificateFingerprint: String(row.certificate_fingerprint),
      adapterVersion: String(row.adapter_version),
    }
  }

  /** Validates through the adapter, then freezes the exact signed NF-e and SOAP envelope. */
  async bindAuthorization(
    input: z.input<typeof prepareSchema>,
    authorization: Extract<SefazExchangeInput, { service: 'authorization' }>,
    adapter: Pick<
      SefazNfe55HomologationAdapter,
      'prepare' | 'wsdlDigest' | 'certificateFingerprint'
    >,
  ): Promise<{ prepared: PreparedSefazExchange; signedXmlDigest: string; requestDigest: string }> {
    const value = prepareSchema.parse(input)
    if (value.parentExchangeId !== null)
      throw new Error('SEFAZ authorization cannot have a parent exchange')
    if (adapter.wsdlDigest !== value.wsdlDigest)
      throw new Error('SEFAZ authorization WSDL differs from drill')
    if (adapter.certificateFingerprint !== value.certificateFingerprint)
      throw new Error('SEFAZ signing certificate differs from drill')
    const schemaDigest = digest.parse(authorization.schemaDigest)
    const prepared = await adapter.prepare(authorization)
    if (
      prepared.service !== 'authorization' ||
      prepared.expectedAccessKey !== authorization.accessKey
    )
      throw new Error('SEFAZ adapter did not prepare the expected authorization')
    const signedText = authorization.signedXml
      .toString('utf8')
      .replace(/^\s*<\?xml\s+[^?]*\?>\s*/i, '')
    if (!signedText || !prepared.request.includes(signedText))
      throw new Error('SEFAZ envelope does not contain the signed NF-e bytes')
    const signed = await this.artifacts.put(
      {
        tenantId: value.tenantId,
        documentId: value.documentId,
        kind: 'homologation_request',
        mediaType: 'application/xml',
        sourceSchema: `sefaz-nfe400-signed-document:${schemaDigest}`,
      },
      authorization.signedXml,
    )
    const request = await this.artifacts.put(
      {
        tenantId: value.tenantId,
        documentId: value.documentId,
        kind: 'homologation_request',
        mediaType: 'application/soap+xml',
        sourceSchema: 'sefaz-nfe400-soap12-request',
      },
      prepared.request,
    )
    await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${value.tenantId}, true)`
      const [reservation] = await tx`select number from fiscal_number_reservations
        where tenant_id = ${value.tenantId} and document_id = ${value.documentId}`
      if (!reservation) throw new Error('Homologation number reservation is unavailable')
      const [existing] = await tx`select drill_grant_id, access_key, number,
          signed_xml_digest, request_digest, schema_digest
        from fiscal_homologation_authorization_bindings
        where tenant_id = ${value.tenantId} and document_id = ${value.documentId}`
      const inserted = existing
        ? []
        : await tx`insert into fiscal_homologation_authorization_bindings (
          tenant_id, document_id, drill_grant_id, access_key, number,
          signed_xml_digest, request_digest, schema_digest
        ) values (
          ${value.tenantId}, ${value.documentId}, ${value.drillGrantId},
          ${authorization.accessKey}, ${reservation.number}, ${signed.digest},
          ${request.digest}, ${schemaDigest}
        ) on conflict do nothing returning document_id`
      const [stored] = existing
        ? [existing]
        : await tx`select drill_grant_id, access_key, number, signed_xml_digest,
            request_digest, schema_digest
          from fiscal_homologation_authorization_bindings
          where tenant_id = ${value.tenantId} and document_id = ${value.documentId}`
      if (
        !stored ||
        stored.drill_grant_id !== value.drillGrantId ||
        stored.access_key !== authorization.accessKey ||
        Number(stored.number) !== Number(reservation.number) ||
        stored.signed_xml_digest !== signed.digest ||
        stored.request_digest !== request.digest ||
        stored.schema_digest !== schemaDigest
      )
        throw new Error('Conflicting immutable homologation authorization binding')
      if (inserted.length > 0)
        await appendAudit(tx, {
          tenantId: value.tenantId,
          actorId: value.actorId,
          action: 'homologation.authorization-bound',
          resourceId: value.documentId,
          detail: {
            drillGrantId: value.drillGrantId,
            accessKey: authorization.accessKey,
            signedXmlDigest: signed.digest,
            requestDigest: request.digest,
          },
        })
    })
    return { prepared, signedXmlDigest: signed.digest, requestDigest: request.digest }
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
        kind: 'homologation_request',
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
        access_key, receipt, authorization_protocol
      ) values (
        ${value.exchangeId}, ${value.tenantId}, ${value.documentId}, ${value.drillGrantId},
        ${value.parentExchangeId}, ${exchange.service}, ${request.digest},
        ${value.endpointDigest}, ${value.wsdlDigest}, ${value.certificateFingerprint},
        ${value.adapterVersion}, ${exchange.expectedAccessKey ?? null},
        ${exchange.expectedReceipt ?? null}, ${exchange.expectedAuthorizationProtocol ?? null}
      ) on conflict do nothing returning id`
      const [stored] = await tx`select document_id, drill_grant_id, parent_exchange_id, service,
          request_digest, endpoint_digest, wsdl_digest, certificate_fingerprint,
          adapter_version, access_key, receipt, authorization_protocol
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
        stored.receipt !== (exchange.expectedReceipt ?? null) ||
        stored.authorization_protocol !== (exchange.expectedAuthorizationProtocol ?? null)
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

  async recoveryTarget(
    tenantId: string,
    documentId: string,
  ): Promise<
    | { service: 'receipt'; parentExchangeId: string; accessKey: string; receipt: string }
    | { service: 'protocol'; parentExchangeId: string; accessKey: string }
  > {
    z.uuid().parse(tenantId)
    z.uuid().parse(documentId)
    const [row] = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      const [terminal] = await tx`select parsed.decision
        from fiscal_homologation_exchanges exchange
        join fiscal_homologation_parsed_responses parsed
          on parsed.tenant_id = exchange.tenant_id and parsed.exchange_id = exchange.id
        where exchange.tenant_id = ${tenantId} and exchange.document_id = ${documentId}
          and parsed.decision in ('authorized', 'rejected', 'cancelled')
        limit 1`
      if (terminal) throw new Error('SEFAZ document already has a terminal homologation decision')
      return tx`select exchange.id, exchange.access_key, parsed.receipt,
          transmission.started_at
        from fiscal_homologation_exchanges exchange
        left join fiscal_homologation_transmissions transmission
          on transmission.tenant_id = exchange.tenant_id
          and transmission.exchange_id = exchange.id
        left join fiscal_homologation_parsed_responses parsed
          on parsed.tenant_id = exchange.tenant_id and parsed.exchange_id = exchange.id
        where exchange.tenant_id = ${tenantId} and exchange.document_id = ${documentId}
          and exchange.service = 'authorization'`
    })
    if (!row?.started_at || !row.access_key)
      throw new Error('No started SEFAZ authorization exists for consultation')
    const parentExchangeId = String(row.id)
    const accessKey = String(row.access_key)
    return row.receipt
      ? { service: 'receipt', parentExchangeId, accessKey, receipt: String(row.receipt) }
      : { service: 'protocol', parentExchangeId, accessKey }
  }

  /** A cancellation may use only the one protocol actually observed as authorized. */
  async cancellationTarget(
    tenantId: string,
    documentId: string,
    exchangeId: string,
  ): Promise<{
    parentExchangeId: string
    drillGrantId: string
    capabilityId: string
    accessKey: string
    protocolNumber: string
    endpointDigest: string
    wsdlDigest: string
    certificateFingerprint: string
    adapterVersion: string
  }> {
    z.uuid().parse(tenantId)
    z.uuid().parse(documentId)
    z.uuid().parse(exchangeId)
    const rows = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select parent.id, parent.drill_grant_id, grant_row.capability_id,
          parent.access_key, parsed.protocol_number, parent.endpoint_digest,
          parent.wsdl_digest, parent.certificate_fingerprint, parent.adapter_version
        from fiscal_homologation_exchanges parent
        join fiscal_homologation_drill_grants grant_row
          on grant_row.tenant_id = parent.tenant_id
          and grant_row.id = parent.drill_grant_id
        join fiscal_homologation_exchanges observed
          on observed.tenant_id = parent.tenant_id
          and (observed.id = parent.id or observed.parent_exchange_id = parent.id)
        join fiscal_homologation_parsed_responses parsed
          on parsed.tenant_id = observed.tenant_id and parsed.exchange_id = observed.id
        where parent.tenant_id = ${tenantId} and parent.document_id = ${documentId}
          and parent.service = 'authorization'
          and observed.service in ('authorization', 'receipt', 'protocol')
          and parsed.decision = 'authorized'
          and parsed.protocol_number is not null
          and grant_row.expires_at > now()
          and not exists (
            select 1 from fiscal_homologation_exchanges event
            where event.tenant_id = parent.tenant_id
              and event.document_id = parent.document_id and event.service = 'event'
              and event.id <> ${exchangeId}
          )
          and not exists (
            select 1 from fiscal_homologation_exchanges event
            join fiscal_homologation_parsed_responses outcome
              on outcome.tenant_id = event.tenant_id and outcome.exchange_id = event.id
            where event.tenant_id = parent.tenant_id
              and event.document_id = parent.document_id and outcome.decision = 'cancelled'
          )`
    })
    const protocols = [...new Set(rows.map((row) => String(row.protocol_number)))]
    if (protocols.length !== 1 || !rows[0])
      throw new Error('Unique authorized homologation protocol is unavailable for cancellation')
    const row = rows[0]
    return {
      parentExchangeId: String(row.id),
      drillGrantId: String(row.drill_grant_id),
      capabilityId: String(row.capability_id),
      accessKey: String(row.access_key),
      protocolNumber: protocols[0] as string,
      endpointDigest: String(row.endpoint_digest),
      wsdlDigest: String(row.wsdl_digest),
      certificateFingerprint: String(row.certificate_fingerprint),
      adapterVersion: String(row.adapter_version),
    }
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
        kind: 'homologation_response',
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
      'homologation_response',
      await this.rawDigest(tenantId, exchangeId),
    )
    if (!raw.bytes.equals(response.response))
      throw new Error('Parsed SEFAZ response bytes differ from stored raw artifact')
    const protocol = response.protocol
      ? await this.artifacts.put(
          {
            tenantId,
            documentId,
            kind: 'homologation_protocol',
            mediaType: 'application/xml',
            sourceSchema: 'sefaz-nfe400-protocol',
          },
          response.protocol,
        )
      : null
    const decision = classifySefazResponse(response)
    await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      const [exchange] = await tx`select document_id, service from fiscal_homologation_exchanges
        where tenant_id = ${tenantId} and id = ${exchangeId}`
      if (exchange?.document_id !== documentId || exchange.service !== response.service)
        throw new Error('Parsed SEFAZ response differs from exchange')
      await tx`insert into fiscal_homologation_parsed_responses (
        tenant_id, exchange_id, response_digest, protocol_digest, cstat,
        document_cstat, event_cstat, receipt, protocol_number, decision, decision_version
      ) values (
        ${tenantId}, ${exchangeId}, ${raw.metadata.digest}, ${protocol?.digest ?? null},
        ${response.statusCode}, ${response.documentStatusCode}, ${response.eventStatusCode},
        ${response.receipt}, ${response.protocolNumber}, ${decision}, ${SEFAZ_DECISION_VERSION}
      ) on conflict do nothing`
      const [stored] = await tx`select response_digest, protocol_digest, cstat,
          document_cstat, event_cstat, receipt, protocol_number, decision, decision_version
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
        stored.protocol_number !== response.protocolNumber ||
        stored.decision !== decision ||
        stored.decision_version !== SEFAZ_DECISION_VERSION
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
