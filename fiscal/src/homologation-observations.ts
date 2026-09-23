import postgres from 'postgres'
import { z } from 'zod'
import type { SefazDecision } from './nfe55/sefaz-decision'

export type HomologationObservation = {
  exchangeId: string
  parentExchangeId: string | null
  service: 'authorization' | 'receipt' | 'protocol' | 'status' | 'event'
  stage: 'prepared' | 'send_started' | 'raw_unparsed' | 'observed'
  decision: SefazDecision
  decisionVersion: string | null
  statusCode: string | null
  documentStatusCode: string | null
  eventStatusCode: string | null
  receipt: string | null
  protocolNumber: string | null
  requestDigest: string
  responseDigest: string | null
  protocolDigest: string | null
  preparedAt: string
  startedAt: string | null
  receivedAt: string | null
  parsedAt: string | null
}

/** Tenant-scoped operational history, with no decrypted XML or credential material. */
export class HomologationObservations {
  readonly #db: ReturnType<typeof postgres>

  constructor(databaseUrl: string) {
    this.#db = postgres(databaseUrl, { max: 5, connection: { statement_timeout: 5000 } })
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  async list(tenantId: string, documentId: string): Promise<HomologationObservation[]> {
    z.uuid().parse(tenantId)
    z.uuid().parse(documentId)
    const rows = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select exchange.id, exchange.parent_exchange_id, exchange.service,
          exchange.request_digest, exchange.prepared_at, transmission.started_at,
          raw.response_digest, raw.received_at, parsed.protocol_digest,
          parsed.cstat, parsed.document_cstat, parsed.event_cstat, parsed.receipt,
          parsed.protocol_number, parsed.decision, parsed.decision_version, parsed.parsed_at
        from fiscal_homologation_exchanges exchange
        left join fiscal_homologation_transmissions transmission
          on transmission.tenant_id = exchange.tenant_id
          and transmission.exchange_id = exchange.id
        left join fiscal_homologation_raw_responses raw
          on raw.tenant_id = exchange.tenant_id and raw.exchange_id = exchange.id
        left join fiscal_homologation_parsed_responses parsed
          on parsed.tenant_id = exchange.tenant_id and parsed.exchange_id = exchange.id
        where exchange.tenant_id = ${tenantId} and exchange.document_id = ${documentId}
        order by exchange.prepared_at, exchange.id`
    })
    return rows.map((row) => ({
      exchangeId: String(row.id),
      parentExchangeId: row.parent_exchange_id ? String(row.parent_exchange_id) : null,
      service: row.service as HomologationObservation['service'],
      stage: row.parsed_at
        ? 'observed'
        : row.received_at
          ? 'raw_unparsed'
          : row.started_at
            ? 'send_started'
            : 'prepared',
      decision: (row.decision ?? 'unknown') as SefazDecision,
      decisionVersion: row.decision_version ? String(row.decision_version) : null,
      statusCode: row.cstat ? String(row.cstat) : null,
      documentStatusCode: row.document_cstat ? String(row.document_cstat) : null,
      eventStatusCode: row.event_cstat ? String(row.event_cstat) : null,
      receipt: row.receipt ? String(row.receipt) : null,
      protocolNumber: row.protocol_number ? String(row.protocol_number) : null,
      requestDigest: String(row.request_digest),
      responseDigest: row.response_digest ? String(row.response_digest) : null,
      protocolDigest: row.protocol_digest ? String(row.protocol_digest) : null,
      preparedAt: new Date(row.prepared_at).toISOString(),
      startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
      receivedAt: row.received_at ? new Date(row.received_at).toISOString() : null,
      parsedAt: row.parsed_at ? new Date(row.parsed_at).toISOString() : null,
    }))
  }
}
