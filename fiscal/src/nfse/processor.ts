import { createHash } from 'node:crypto'
import postgres from 'postgres'
import type { FiscalArtifacts } from '../artifacts'
import type { FiscalCalculations } from '../calculations'
import { canonicalDigest } from '../canonical-json'
import type { DispatchLease, FiscalDispatch } from '../dispatch'
import type { FiscalProjections } from '../projections'
import { ibgeMunicipality } from './reference'
import type {
  DeterministicNfseSimulator,
  NfseEventSimulatorResult,
  NfseGeneration,
  NfseSimulatedProvider,
  NfseSimulatorResult,
} from './simulator'

const SOURCE = 'horizon-nfse-national-simulator-v1'

type Simulator = Pick<
  DeterministicNfseSimulator,
  'submit' | 'consult' | 'submitCancellation' | 'consultCancellation'
>

/**
 * Worker steps for an NFS-e. The national system is synchronous: the first send decides
 * unless it times out. After that, the DPS identifier is consulted before any resend, so
 * a lost response never produces a second NFS-e.
 */
export class NfseDispatchProcessor {
  constructor(
    private readonly dispatch: Pick<FiscalDispatch, 'recordObservation' | 'retry'>,
    private readonly artifacts: Pick<FiscalArtifacts, 'get' | 'put'>,
    private readonly simulator: Simulator,
    private readonly facts: Pick<NfseProcessingFacts, 'provider' | 'frozenValues' | 'nfseXml'>,
    private readonly retryDelayMilliseconds = 1_000,
  ) {}

  async issue(lease: DispatchLease, workerId: string): Promise<void> {
    if ((lease.kind !== 'issuance' && lease.kind !== 'status_query') || !lease.artifactDigest)
      throw new Error('Fiscal NFS-e worker received an unsupported command')
    const signedDps = (
      await this.artifacts.get(lease.tenantId, lease.documentId, 'signed_xml', lease.artifactDigest)
    ).bytes
    const provider = await this.facts.provider(lease.tenantId, lease.documentId)
    const request = {
      commandId: lease.issuanceCommandId ?? lease.commandId,
      requestDigest: lease.requestDigest,
      dpsDigest: lease.artifactDigest,
      attemptCount:
        lease.kind === 'status_query' ? Math.max(2, lease.attemptCount + 1) : lease.attemptCount,
      signedDps,
      provider,
    }
    let observation: NfseSimulatorResult
    let observationKind: 'response' | 'consultation'
    if (lease.kind === 'issuance' && lease.attemptCount === 1) {
      observation = await this.simulator.submit(request)
      observationKind = 'response'
    } else {
      // `GET /dps/{id}` first: only a DPS the national system never received is resent.
      observation = await this.simulator.consult(request)
      observationKind = 'consultation'
      if (observation.outcome === 'not_found') {
        observation = await this.simulator.submit(request)
        observationKind = 'response'
      }
    }
    const put = (
      kind: 'issuance_response' | 'nfse_xml' | 'substitution_event',
      bytes: Buffer,
      mediaType: string,
    ) =>
      this.artifacts.put(
        {
          tenantId: lease.tenantId,
          documentId: lease.documentId,
          commandId: lease.commandId,
          kind,
          mediaType,
          sourceSchema: SOURCE,
        },
        bytes,
      )
    const response = await put('issuance_response', observation.response, 'application/json')
    const nfse = observation.nfseXml
      ? await put('nfse_xml', observation.nfseXml, 'application/xml')
      : null
    const substitution = observation.substitutionEvent
      ? await put('substitution_event', observation.substitutionEvent, 'application/xml')
      : null
    const outcome = observation.outcome === 'not_found' ? 'unknown' : observation.outcome
    const generation =
      outcome === 'authorized' && observation.generation && nfse
        ? await this.generationRecord(
            lease,
            observation.generation,
            nfse.digest,
            substitution?.digest ?? null,
          )
        : undefined
    await this.dispatch.recordObservation({
      tenantId: lease.tenantId,
      commandId: lease.commandId,
      workerId,
      observationKind,
      outcome,
      providerCorrelation: observation.providerCorrelation,
      responseDigest: response.digest,
      protocolDigest: nfse?.digest ?? null,
      ...(observation.rejectionCode ? { rejectionCode: observation.rejectionCode } : {}),
      ...(generation ? { nfse: generation } : {}),
    })
    if (outcome === 'unknown')
      await this.dispatch.retry(
        lease.tenantId,
        lease.commandId,
        workerId,
        new Date(Date.now() + this.retryDelayMilliseconds),
      )
  }

  async cancel(lease: DispatchLease, workerId: string): Promise<void> {
    if (!lease.artifactDigest) throw new Error('Fiscal NFS-e cancellation event is missing')
    const eventXml = (
      await this.artifacts.get(
        lease.tenantId,
        lease.documentId,
        'cancellation_request',
        lease.artifactDigest,
      )
    ).bytes
    const request = {
      commandId: lease.cancellationCommandId ?? lease.commandId,
      requestDigest: lease.requestDigest,
      eventXmlDigest: lease.artifactDigest,
      attemptCount:
        lease.kind === 'cancellation_query'
          ? Math.max(2, lease.attemptCount + 1)
          : lease.attemptCount,
      eventXml,
      nfseXml: await this.facts.nfseXml(lease.tenantId, lease.documentId),
    }
    let observation: NfseEventSimulatorResult
    let observationKind: 'response' | 'consultation'
    if (lease.kind === 'cancellation' && lease.attemptCount === 1) {
      observation = await this.simulator.submitCancellation(request)
      observationKind = 'response'
    } else {
      observation = await this.simulator.consultCancellation(request)
      observationKind = 'consultation'
      if (observation.outcome === 'not_found') {
        observation = await this.simulator.submitCancellation(request)
        observationKind = 'response'
      }
    }
    const put = (
      kind: 'cancellation_response' | 'cancellation_protocol',
      bytes: Buffer,
      mediaType: string,
    ) =>
      this.artifacts.put(
        {
          tenantId: lease.tenantId,
          documentId: lease.documentId,
          commandId: lease.commandId,
          kind,
          mediaType,
          sourceSchema: SOURCE,
        },
        bytes,
      )
    const response = await put('cancellation_response', observation.response, 'application/json')
    const protocol = observation.protocol
      ? await put('cancellation_protocol', observation.protocol, 'application/xml')
      : null
    const outcome = observation.outcome === 'not_found' ? 'unknown' : observation.outcome
    await this.dispatch.recordObservation({
      tenantId: lease.tenantId,
      commandId: lease.commandId,
      workerId,
      observationKind,
      outcome,
      providerCorrelation: observation.providerCorrelation,
      responseDigest: response.digest,
      protocolDigest: protocol?.digest ?? null,
      ...(observation.rejectionCode ? { rejectionCode: observation.rejectionCode } : {}),
    })
    if (outcome === 'unknown')
      await this.dispatch.retry(
        lease.tenantId,
        lease.commandId,
        workerId,
        new Date(Date.now() + this.retryDelayMilliseconds),
      )
  }

  /** The generation, and whether its values match the locked calculation. */
  private async generationRecord(
    lease: DispatchLease,
    generation: NfseGeneration,
    nfseXmlDigest: string,
    substitutionEventDigest: string | null,
  ) {
    const locked = await this.facts.frozenValues(lease.tenantId, lease.documentId)
    const generated = {
      ISS: toMinor(generation.issAmount),
      CBS: toMinor(generation.cbsAmount),
      IBS_UF: toMinor(generation.ibsUfAmount),
      IBS_MUN: toMinor(generation.ibsMunAmount),
      gross: toMinor(generation.serviceAmount),
    }
    return {
      dpsId: generation.dpsId,
      nfseKey: generation.nfseKey,
      nfseNumber: generation.nfseNumber,
      processedAt: generation.processedAt,
      nfseXmlDigest,
      valuesDigest: canonicalDigest({ generated, locked }),
      calculationMatches: canonicalDigest(generated) === canonicalDigest(locked),
      substitutionEventDigest,
    }
  }
}

/** Facts the worker reads for the simulated national system. */
export class NfseProcessingFacts {
  readonly #db: ReturnType<typeof postgres>

  constructor(
    databaseUrl: string,
    private readonly projections: Pick<FiscalProjections, 'readIssuer'>,
    private readonly calculations: Pick<FiscalCalculations, 'readFrozen'>,
    private readonly artifacts: Pick<FiscalArtifacts, 'get'>,
    private readonly issuerAddress: { street: string; number: string; district: string },
  ) {
    this.#db = postgres(databaseUrl, { max: 3, connection: { statement_timeout: 5000 } })
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  /** The CNPJ cadastre answer: the DPS of a provider-issuer carries no name or address. */
  async provider(tenantId: string, documentId: string): Promise<NfseSimulatedProvider> {
    const [binding] = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select issuer_profile_revision from fiscal_document_readiness_bindings
        where tenant_id = ${tenantId} and document_id = ${documentId}`
    })
    if (!binding) throw new Error('NFS-e readiness evidence is unavailable')
    const issuer = await this.projections.readIssuer(
      tenantId,
      Number(binding.issuer_profile_revision),
    )
    const municipalityCode = issuer?.company.address.municipalityCode
    const municipality = municipalityCode ? ibgeMunicipality(municipalityCode) : null
    const postalCode = issuer?.company.address.postalCode?.replace(/\D/g, '') ?? ''
    if (!issuer || !municipalityCode || !municipality || !/^\d{8}$/.test(postalCode))
      throw new Error('NFS-e provider facts are incomplete')
    return {
      legalName: issuer.company.legalName,
      address: { ...this.issuerAddress, municipalityCode, uf: municipality.uf, postalCode },
    }
  }

  async frozenValues(tenantId: string, documentId: string): Promise<Record<string, string>> {
    const frozen = await this.calculations.readFrozen(tenantId, documentId)
    if (!frozen) throw new Error('NFS-e calculation is unavailable')
    const values: Record<string, string> = { gross: frozen.result.totals.gross.amount }
    for (const line of frozen.result.lines)
      for (const component of [...line.components.legacy, ...line.components.ibsCbs])
        values[component.code] = component.amount.amount
    return values
  }

  async nfseXml(tenantId: string, documentId: string): Promise<Buffer> {
    const [generation] = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select nfse_xml_digest from fiscal_nfse_generations
        where tenant_id = ${tenantId} and document_id = ${documentId}`
    })
    if (!generation) throw new Error('NFS-e generation is unavailable')
    const found = await this.artifacts.get(
      tenantId,
      documentId,
      'nfse_xml',
      String(generation.nfse_xml_digest),
    )
    if (createHash('sha256').update(found.bytes).digest('hex') !== generation.nfse_xml_digest)
      throw new Error('NFS-e XML integrity failure')
    return found.bytes
  }
}

function toMinor(value: string): string {
  const [integer = '0', fraction = ''] = value.split('.')
  return String(BigInt(integer) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2)))
}
