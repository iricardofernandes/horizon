import { createHash } from 'node:crypto'
import type { FiscalArtifacts } from './artifacts'
import type { DispatchLease, FiscalDispatch } from './dispatch'
import { renderSimulatedDanfe } from './nfe55/danfe'
import type {
  CancellationSimulatorResult,
  DeterministicNfe55Simulator,
  SimulatorResult,
} from './nfe55/simulator'

export class FiscalIssueWorker {
  constructor(
    private readonly dispatch: Pick<FiscalDispatch, 'claim' | 'recordObservation' | 'retry'>,
    private readonly artifacts: Pick<FiscalArtifacts, 'get' | 'put'>,
    private readonly simulator: Pick<
      DeterministicNfe55Simulator,
      'submit' | 'consult' | 'submitCancellation' | 'consultCancellation'
    >,
    private readonly retryDelayMilliseconds = 1_000,
  ) {}

  async processOne(tenantId: string, workerId: string): Promise<boolean> {
    const lease = await this.dispatch.claim({ tenantId, workerId })
    if (!lease) return false
    if (lease.kind === 'cancellation' || lease.kind === 'cancellation_query') {
      await this.processCancellation(lease, workerId)
      return true
    }
    if ((lease.kind !== 'issuance' && lease.kind !== 'status_query') || !lease.artifactDigest)
      throw new Error('Fiscal issue worker received an unsupported command')
    const request = {
      commandId: lease.issuanceCommandId ?? lease.commandId,
      requestDigest: lease.requestDigest,
      signedXmlDigest: lease.artifactDigest,
      attemptCount:
        lease.kind === 'status_query' ? Math.max(2, lease.attemptCount + 1) : lease.attemptCount,
    }
    let observation: SimulatorResult
    let observationKind: 'response' | 'consultation'
    if (lease.kind === 'status_query') {
      observation = await this.simulator.consult(request)
      observationKind = 'consultation'
      if (observation.outcome === 'not_found') {
        const signed = await this.artifacts.get(
          tenantId,
          lease.documentId,
          'signed_xml',
          lease.artifactDigest,
        )
        observation = await this.simulator.submit({ ...request, signedXml: signed.bytes })
        observationKind = 'response'
      }
    } else if (lease.attemptCount === 1) {
      const signed = await this.artifacts.get(
        tenantId,
        lease.documentId,
        'signed_xml',
        lease.artifactDigest,
      )
      observation = await this.simulator.submit({ ...request, signedXml: signed.bytes })
      observationKind = 'response'
    } else {
      observation = await this.simulator.consult(request)
      observationKind = 'consultation'
      if (observation.outcome === 'not_found') {
        const signed = await this.artifacts.get(
          tenantId,
          lease.documentId,
          'signed_xml',
          lease.artifactDigest,
        )
        observation = await this.simulator.submit({ ...request, signedXml: signed.bytes })
        observationKind = 'response'
      }
    }
    const response = await this.artifacts.put(
      {
        tenantId,
        documentId: lease.documentId,
        commandId: lease.commandId,
        kind: 'issuance_response',
        mediaType: 'application/json',
        sourceSchema: 'horizon-nfe55-simulator-v1',
      },
      observation.response,
    )
    const protocol = observation.protocol
      ? await this.artifacts.put(
          {
            tenantId,
            documentId: lease.documentId,
            commandId: lease.commandId,
            kind: 'authorization_protocol',
            mediaType: 'application/json',
            sourceSchema: 'horizon-nfe55-simulator-v1',
          },
          observation.protocol,
        )
      : null
    const outcome = observation.outcome === 'not_found' ? 'unknown' : observation.outcome
    if (outcome === 'authorized' && observation.protocol) {
      const signed = await this.artifacts.get(
        tenantId,
        lease.documentId,
        'signed_xml',
        lease.artifactDigest,
      )
      await this.artifacts.put(
        {
          tenantId,
          documentId: lease.documentId,
          commandId: lease.commandId,
          kind: 'danfe',
          mediaType: 'application/pdf',
          sourceSchema: 'horizon-danfe-authorized-v1',
        },
        await renderSimulatedDanfe({
          signedXml: signed.bytes,
          protocol: observation.protocol,
          state: 'authorized',
        }),
      )
    }
    await this.dispatch.recordObservation({
      tenantId,
      commandId: lease.commandId,
      workerId,
      observationKind,
      outcome,
      providerCorrelation: observation.providerCorrelation,
      responseDigest: response.digest,
      protocolDigest: protocol?.digest ?? null,
    })
    if (outcome === 'unknown')
      await this.dispatch.retry(
        tenantId,
        lease.commandId,
        workerId,
        new Date(Date.now() + this.retryDelayMilliseconds),
      )
    return true
  }

  private async processCancellation(lease: DispatchLease, workerId: string): Promise<void> {
    if (!lease.artifactDigest) throw new Error('Fiscal cancellation request artifact is missing')
    const request = {
      commandId: lease.cancellationCommandId ?? lease.commandId,
      requestDigest: lease.requestDigest,
      eventXmlDigest: lease.artifactDigest,
      attemptCount:
        lease.kind === 'cancellation_query'
          ? Math.max(2, lease.attemptCount + 1)
          : lease.attemptCount,
    }
    let observation: CancellationSimulatorResult
    let observationKind: 'response' | 'consultation'
    if (lease.kind === 'cancellation_query') {
      observation = await this.simulator.consultCancellation(request)
      observationKind = 'consultation'
      if (observation.outcome === 'not_found') {
        const event = await this.artifacts.get(
          lease.tenantId,
          lease.documentId,
          'cancellation_request',
          lease.artifactDigest,
        )
        observation = await this.simulator.submitCancellation({ ...request, eventXml: event.bytes })
        observationKind = 'response'
      }
    } else if (lease.attemptCount === 1) {
      const event = await this.artifacts.get(
        lease.tenantId,
        lease.documentId,
        'cancellation_request',
        lease.artifactDigest,
      )
      observation = await this.simulator.submitCancellation({ ...request, eventXml: event.bytes })
      observationKind = 'response'
    } else {
      observation = await this.simulator.consultCancellation(request)
      observationKind = 'consultation'
      if (observation.outcome === 'not_found') {
        const event = await this.artifacts.get(
          lease.tenantId,
          lease.documentId,
          'cancellation_request',
          lease.artifactDigest,
        )
        observation = await this.simulator.submitCancellation({ ...request, eventXml: event.bytes })
        observationKind = 'response'
      }
    }
    const response = await this.artifacts.put(
      {
        tenantId: lease.tenantId,
        documentId: lease.documentId,
        commandId: lease.commandId,
        kind: 'cancellation_response',
        mediaType: 'application/json',
        sourceSchema: 'horizon-nfe55-simulator-v1',
      },
      observation.response,
    )
    const protocol = observation.protocol
      ? await this.artifacts.put(
          {
            tenantId: lease.tenantId,
            documentId: lease.documentId,
            commandId: lease.commandId,
            kind: 'cancellation_protocol',
            mediaType: 'application/json',
            sourceSchema: 'horizon-nfe55-simulator-v1',
          },
          observation.protocol,
        )
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
    })
    if (outcome === 'unknown')
      await this.dispatch.retry(
        lease.tenantId,
        lease.commandId,
        workerId,
        new Date(Date.now() + this.retryDelayMilliseconds),
      )
  }
}

export function artifactDigest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}
