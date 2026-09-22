import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { ArtifactMetadata } from './artifacts'
import { artifactDigest, FiscalIssueWorker } from './issue-worker'
import { DeterministicNfe55Simulator } from './nfe55/simulator'

const tenantId = randomUUID()
const documentId = randomUUID()
const commandId = randomUUID()
const signedXml = Buffer.from('<NFe>signed simulation bytes</NFe>')
const signedXmlDigest = artifactDigest(signedXml)

describe('durable NF-e issue worker', () => {
  it('persists unknown response, consults after restart and then records authorization', async () => {
    const leases = [lease(1), lease(2)]
    const observations: Array<Record<string, unknown>> = []
    const retry = vi.fn(async () => undefined)
    const dispatch = {
      async claim() {
        return leases.shift() ?? null
      },
      async recordObservation(input: Record<string, unknown>) {
        observations.push(input)
        return { id: randomUUID(), existing: false }
      },
      retry,
    }
    const artifacts = memoryArtifacts()
    const firstSimulator = new DeterministicNfe55Simulator(() => 'timeout-after-accept')
    expect(
      await new FiscalIssueWorker(dispatch, artifacts, firstSimulator, 0).processOne(
        tenantId,
        'worker:a',
      ),
    ).toBe(true)
    expect(observations[0]).toMatchObject({ outcome: 'unknown', observationKind: 'response' })
    expect(retry).toHaveBeenCalledOnce()

    // A new simulator instance proves that no in-process result map is required.
    const restartedSimulator = new DeterministicNfe55Simulator(() => 'timeout-after-accept')
    expect(
      await new FiscalIssueWorker(dispatch, artifacts, restartedSimulator, 0).processOne(
        tenantId,
        'worker:b',
      ),
    ).toBe(true)
    expect(observations[1]).toMatchObject({
      outcome: 'authorized',
      observationKind: 'consultation',
      providerCorrelation: expect.stringMatching(/^simulation:/),
    })
  })

  it('consults before resending the exact signed bytes after timeout-before-accept', async () => {
    const simulator = new DeterministicNfe55Simulator(() => 'timeout-before-accept')
    const submit = vi.spyOn(simulator, 'submit')
    const consult = vi.spyOn(simulator, 'consult')
    const leases = [lease(1), lease(2)]
    const outcomes: string[] = []
    const dispatch = {
      async claim() {
        return leases.shift() ?? null
      },
      async recordObservation(input: { outcome: string }) {
        outcomes.push(input.outcome)
        return { id: randomUUID(), existing: false }
      },
      async retry() {},
    }
    const artifacts = memoryArtifacts()
    const worker = new FiscalIssueWorker(dispatch, artifacts, simulator, 0)
    await worker.processOne(tenantId, 'worker:a')
    await worker.processOne(tenantId, 'worker:b')
    expect(outcomes).toEqual(['unknown', 'authorized'])
    expect(consult).toHaveBeenCalledOnce()
    expect(submit).toHaveBeenCalledTimes(2)
    expect(submit.mock.calls[0]?.[0].signedXml).toEqual(signedXml)
    expect(submit.mock.calls[1]?.[0].signedXml).toEqual(signedXml)
  })

  it('fails closed if stored signed bytes do not match their immutable digest', async () => {
    const simulator = new DeterministicNfe55Simulator(() => 'authorized')
    await expect(
      simulator.submit({
        commandId,
        requestDigest: '1'.repeat(64),
        signedXmlDigest,
        signedXml: Buffer.from('mutated'),
        attemptCount: 1,
      }),
    ).rejects.toThrow('digest mismatch')
  })

  it('consults an explicit status query with the original issuance identity and never resends', async () => {
    const simulator = new DeterministicNfe55Simulator(() => 'timeout-after-accept')
    const submit = vi.spyOn(simulator, 'submit')
    const consult = vi.spyOn(simulator, 'consult')
    const observations: Array<Record<string, unknown>> = []
    const worker = new FiscalIssueWorker(
      {
        async claim() {
          return {
            ...lease(1),
            kind: 'status_query',
            commandId: randomUUID(),
            issuanceCommandId: commandId,
          }
        },
        async recordObservation(input: Record<string, unknown>) {
          observations.push(input)
          return { id: randomUUID(), existing: false }
        },
        async retry() {},
      },
      memoryArtifacts(),
      simulator,
    )
    await worker.processOne(tenantId, 'worker:query')
    expect(submit).not.toHaveBeenCalled()
    expect(consult).toHaveBeenCalledWith({
      commandId,
      requestDigest: '1'.repeat(64),
      signedXmlDigest,
      attemptCount: 2,
    })
    expect(observations[0]).toMatchObject({
      observationKind: 'consultation',
      outcome: 'authorized',
    })
  })
})

function lease(attemptCount: number) {
  return {
    tenantId,
    commandId,
    documentId,
    kind: 'issuance' as const,
    requestDigest: '1'.repeat(64),
    artifactDigest: signedXmlDigest,
    attemptCount,
    leaseUntil: '2026-09-22T15:00:00.000Z',
  }
}

function memoryArtifacts() {
  return {
    async get() {
      return {
        bytes: Buffer.from(signedXml),
        metadata: metadata('signed_xml', signedXmlDigest, signedXml.length),
      }
    },
    async put(input: { kind: ArtifactMetadata['kind'] }, bytes: Buffer) {
      return metadata(input.kind, artifactDigest(bytes), bytes.length)
    },
  }
}

function metadata(kind: ArtifactMetadata['kind'], digest: string, size: number): ArtifactMetadata {
  return {
    tenantId,
    documentId,
    kind,
    digest,
    size,
    mediaType: 'application/json',
    sourceSchema: 'test',
    createdAt: '2026-09-22T15:00:00.000Z',
  }
}
