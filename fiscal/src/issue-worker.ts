import { createHash } from 'node:crypto'
import type { FiscalArtifacts } from './artifacts'
import type { DispatchLease, FiscalDispatch } from './dispatch'
import { renderSimulatedDanfeNfce } from './nfce65/danfe'
import type { DeterministicNfce65Simulator, Nfce65SimulatorResult } from './nfce65/simulator'
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
    /** The model 65 authority; without it an NFC-e command is never processed. */
    private readonly consumerSimulator?: Pick<
      DeterministicNfce65Simulator,
      'submit' | 'consult' | 'submitCancellation' | 'consultCancellation'
    >,
  ) {}

  async processOne(tenantId: string, workerId: string): Promise<boolean> {
    const lease = await this.dispatch.claim({ tenantId, workerId })
    if (!lease) return false
    if (lease.model === '65' && !this.consumerSimulator)
      throw new Error('Fiscal worker has no model 65 simulator')
    if (lease.kind === 'cancellation' || lease.kind === 'cancellation_query') {
      await this.processCancellation(lease, workerId)
      return true
    }
    if (lease.model === '65') {
      await this.processConsumerSale(lease, workerId)
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

  /**
   * Model 65 is synchronous: the first send decides, unless it times out; then the key is
   * consulted before any resend, and a resend the authority first sees late is rejected.
   */
  private async processConsumerSale(lease: DispatchLease, workerId: string): Promise<void> {
    const simulator = this.consumerSimulator
    if (!simulator || (lease.kind !== 'issuance' && lease.kind !== 'status_query'))
      throw new Error('Fiscal issue worker received an unsupported command')
    if (!lease.artifactDigest) throw new Error('Fiscal signed XML artifact is missing')
    const signed = await this.artifacts.get(
      lease.tenantId,
      lease.documentId,
      'signed_xml',
      lease.artifactDigest,
    )
    const request = {
      commandId: lease.issuanceCommandId ?? lease.commandId,
      requestDigest: lease.requestDigest,
      signedXmlDigest: lease.artifactDigest,
      attemptCount:
        lease.kind === 'status_query' ? Math.max(2, lease.attemptCount + 1) : lease.attemptCount,
      signedXml: signed.bytes,
    }
    let observation: Nfce65SimulatorResult
    let observationKind: 'response' | 'consultation'
    if (lease.kind === 'issuance' && lease.attemptCount === 1) {
      observation = await simulator.submit(request)
      observationKind = 'response'
    } else {
      observation = await simulator.consult(request)
      observationKind = 'consultation'
      if (observation.outcome === 'not_found') {
        observation = await simulator.submit(request)
        observationKind = 'response'
      }
    }
    const put = (kind: 'issuance_response' | 'authorization_protocol', bytes: Buffer) =>
      this.artifacts.put(
        {
          tenantId: lease.tenantId,
          documentId: lease.documentId,
          commandId: lease.commandId,
          kind,
          mediaType: 'application/json',
          sourceSchema: 'horizon-nfce65-simulator-v1',
        },
        bytes,
      )
    const response = await put('issuance_response', observation.response)
    const protocol = observation.protocol
      ? await put('authorization_protocol', observation.protocol)
      : null
    const outcome = observation.outcome === 'not_found' ? 'unknown' : observation.outcome
    if (outcome === 'authorized' && observation.protocol)
      await this.artifacts.put(
        {
          tenantId: lease.tenantId,
          documentId: lease.documentId,
          commandId: lease.commandId,
          kind: 'danfe',
          mediaType: 'application/pdf',
          sourceSchema: 'horizon-danfe-nfce-authorized-v1',
        },
        await renderSimulatedDanfeNfce({
          signedXml: signed.bytes,
          protocol: observation.protocol,
          state: 'authorized',
        }),
      )
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

  private async processCancellation(lease: DispatchLease, workerId: string): Promise<void> {
    if (!lease.artifactDigest) throw new Error('Fiscal cancellation request artifact is missing')
    const simulator =
      lease.model === '65' && this.consumerSimulator ? this.consumerSimulator : this.simulator
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
      observation = await simulator.consultCancellation(request)
      observationKind = 'consultation'
      if (observation.outcome === 'not_found') {
        const event = await this.artifacts.get(
          lease.tenantId,
          lease.documentId,
          'cancellation_request',
          lease.artifactDigest,
        )
        observation = await simulator.submitCancellation({ ...request, eventXml: event.bytes })
        observationKind = 'response'
      }
    } else if (lease.attemptCount === 1) {
      const event = await this.artifacts.get(
        lease.tenantId,
        lease.documentId,
        'cancellation_request',
        lease.artifactDigest,
      )
      observation = await simulator.submitCancellation({ ...request, eventXml: event.bytes })
      observationKind = 'response'
    } else {
      observation = await simulator.consultCancellation(request)
      observationKind = 'consultation'
      if (observation.outcome === 'not_found') {
        const event = await this.artifacts.get(
          lease.tenantId,
          lease.documentId,
          'cancellation_request',
          lease.artifactDigest,
        )
        observation = await simulator.submitCancellation({ ...request, eventXml: event.bytes })
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
