import { randomUUID } from 'node:crypto'
import { fiscalServiceDocumentOutcome } from '@horizon/contracts'
import type postgres from 'postgres'
import { canonicalDigest } from '../canonical-json'

/** What the national system generated, recorded before the NFS-e becomes authorized. */
export async function recordNfseGeneration(
  tx: postgres.TransactionSql,
  input: {
    tenantId: string
    documentId: string
    commandId: string
    dpsId: string
    nfseKey: string
    nfseNumber: string
    processedAt: string
    nfseXmlDigest: string
    valuesDigest: string
    calculationMatches: boolean
  },
): Promise<void> {
  const [binding] = await tx`select access_key from fiscal_document_issuance_bindings
    where tenant_id = ${input.tenantId} and document_id = ${input.documentId}`
  if (binding?.access_key !== input.dpsId)
    throw new Error('NFS-e generation is for another DPS than the one bound')
  const inserted = await tx`insert into fiscal_nfse_generations (
      tenant_id, document_id, command_id, dps_id, nfse_key, nfse_number, processed_at,
      nfse_xml_digest, values_digest, calculation_matches
    ) values (
      ${input.tenantId}, ${input.documentId}, ${input.commandId}, ${input.dpsId},
      ${input.nfseKey}, ${input.nfseNumber}, ${input.processedAt}, ${input.nfseXmlDigest},
      ${input.valuesDigest}, ${input.calculationMatches}
    ) on conflict (tenant_id, document_id) do nothing returning document_id`
  if (inserted.length > 0) return
  const [existing] = await tx`select nfse_key, nfse_xml_digest from fiscal_nfse_generations
    where tenant_id = ${input.tenantId} and document_id = ${input.documentId}`
  if (existing?.nfse_key !== input.nfseKey || existing?.nfse_xml_digest !== input.nfseXmlDigest)
    throw new Error('Conflicting NFS-e generation record')
}

/**
 * Publishes the NFS-e outcome. When a substitute is generated, the national system has
 * registered event 105102 on the original: the original becomes cancelled in the same
 * transaction and its own cancellation names the substitute.
 */
export async function appendServiceOutcome(
  tx: postgres.TransactionSql,
  input: {
    tenantId: string
    documentId: string
    outcome: 'authorized' | 'rejected' | 'cancelled'
    providerCorrelation: string | null
    responseDigest: string
    protocolDigest: string | null
    rejectionCode?: string | null
    substitutionEventDigest?: string | null
  },
): Promise<void> {
  const document = await readFacts(tx, input.tenantId, input.documentId)
  const substitutes = document.substitutes_document_id
    ? String(document.substitutes_document_id)
    : null
  const fact = factOf(document, input)
  let payload: unknown
  if (input.outcome === 'authorized') {
    if (!input.providerCorrelation || !input.protocolDigest)
      throw new Error('NFS-e generation evidence is incomplete')
    payload = {
      ...fact,
      outcome: 'authorized',
      authorityReference: input.providerCorrelation,
      protocolDigest: input.protocolDigest,
      substitutesDocumentId: substitutes,
    }
  } else if (input.outcome === 'cancelled') {
    if (!input.providerCorrelation || !input.protocolDigest)
      throw new Error('NFS-e cancellation evidence is incomplete')
    payload = {
      ...fact,
      outcome: 'cancelled',
      authorityReference: input.providerCorrelation,
      protocolDigest: input.protocolDigest,
      cancellation: { kind: 'event-101101' },
    }
  } else
    payload = {
      ...fact,
      outcome: 'rejected',
      authorityReference: input.providerCorrelation,
      rejectionCode: input.rejectionCode ?? 'SIMULATED_REJECTION',
      protocolDigest: input.protocolDigest,
    }
  await outbox(tx, input.tenantId, payload)
  if (input.outcome === 'authorized' && substitutes)
    await cancelBySubstitution(tx, {
      tenantId: input.tenantId,
      originalDocumentId: substitutes,
      substituteDocumentId: input.documentId,
      eventDigest: input.substitutionEventDigest ?? null,
      providerCorrelation: input.providerCorrelation,
    })
}

async function cancelBySubstitution(
  tx: postgres.TransactionSql,
  input: {
    tenantId: string
    originalDocumentId: string
    substituteDocumentId: string
    eventDigest: string | null
    providerCorrelation: string | null
  },
): Promise<void> {
  if (!input.eventDigest || !input.providerCorrelation)
    throw new Error('A substitute NFS-e needs the substitution event (105102)')
  const [request] = await tx`select reason_code from fiscal_nfse_substitution_requests
    where tenant_id = ${input.tenantId} and substitute_document_id = ${input.substituteDocumentId}`
  if (!request) throw new Error('NFS-e substitution request is unavailable')
  await tx`insert into fiscal_nfse_substitutions (
      tenant_id, original_document_id, substitute_document_id, reason_code, event_digest
    ) values (
      ${input.tenantId}, ${input.originalDocumentId}, ${input.substituteDocumentId},
      ${request.reason_code}, ${input.eventDigest}
    )`
  await tx`update fiscal_documents set status = 'cancelled'
    where tenant_id = ${input.tenantId} and id = ${input.originalDocumentId}`
  await tx`insert into fiscal_transitions (id, tenant_id, document_id, kind, detail)
    values (${randomUUID()}, ${input.tenantId}, ${input.originalDocumentId}, 'cancelled',
      ${JSON.stringify({ substitutedBy: input.substituteDocumentId, event: '105102' })}::jsonb)`
  const original = await readFacts(tx, input.tenantId, input.originalDocumentId)
  await outbox(tx, input.tenantId, {
    ...factOf(original, {
      documentId: input.originalDocumentId,
      outcome: 'cancelled',
      responseDigest: input.eventDigest,
      protocolDigest: input.eventDigest,
    }),
    outcome: 'cancelled',
    authorityReference: input.providerCorrelation,
    protocolDigest: input.eventDigest,
    cancellation: { kind: 'substitution', substitutedBy: input.substituteDocumentId },
  })
}

async function readFacts(tx: postgres.TransactionSql, tenantId: string, documentId: string) {
  const [document] = await tx`select document.id, document.root_document_id, document.revision,
      document.service_origin_id, document.substitutes_document_id,
      origin.municipality_code, origin.competence_date::text as competence_date,
      origin.source_module, origin.source_document_type, origin.source_id, origin.source_period,
      capability.adapter_version
    from fiscal_documents document
    join fiscal_service_origins origin on origin.tenant_id = document.tenant_id
      and origin.id = document.service_origin_id
    join fiscal_document_issuance_bindings binding on binding.tenant_id = document.tenant_id
      and binding.document_id = document.id
    join fiscal_capability_definitions capability on capability.tenant_id = binding.tenant_id
      and capability.id = binding.capability_id
    where document.tenant_id = ${tenantId} and document.id = ${documentId}`
  if (!document) throw new Error('NFS-e outcome facts are unavailable')
  return document
}

function factOf(
  document: postgres.Row,
  input: {
    documentId: string
    outcome: string
    responseDigest: string
    protocolDigest: string | null
  },
) {
  return {
    documentId: input.documentId,
    rootDocumentId: String(document.root_document_id),
    revision: Number(document.revision),
    serviceOriginId: String(document.service_origin_id),
    sourceKey: document.source_id
      ? {
          module: String(document.source_module),
          documentType: String(document.source_document_type),
          id: String(document.source_id),
          period: String(document.source_period),
        }
      : null,
    municipalityCode: String(document.municipality_code),
    competence: String(document.competence_date).slice(0, 7),
    model: 'nfse' as const,
    environment: 'simulation' as const,
    simulated: true as const,
    adapterVersion: String(document.adapter_version),
    statusDigest: canonicalDigest({
      documentId: input.documentId,
      outcome: input.outcome,
      responseDigest: input.responseDigest,
      protocolDigest: input.protocolDigest,
    }),
    observedAt: new Date().toISOString(),
  }
}

async function outbox(tx: postgres.TransactionSql, tenantId: string, candidate: unknown) {
  const payload = fiscalServiceDocumentOutcome.payload.parse(candidate)
  await tx`insert into fiscal_outbox (tenant_id, event_id, event_type, payload)
    values (${tenantId}, ${randomUUID()}, ${fiscalServiceDocumentOutcome.type},
      ${tx.json(payload as postgres.JSONValue)})`
}
