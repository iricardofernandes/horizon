import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { SimulatorScenario } from '../nfe55/simulator'
import { DeterministicNfce65Simulator, NFCE_MAX_EMISSION_DELAY_MS } from './simulator'
import { nfceFixture } from './spec-fixture'
import { serializeNfce65 } from './xml'

const signedXml = serializeNfce65(nfceFixture())
const issuedAt = Date.parse(nfceFixture().issuedAt)

function request(attemptCount: number) {
  return {
    commandId: '6f1f3c4e-2b1a-4c7e-9a55-0d7b8e2f4a10',
    requestDigest: 'a'.repeat(64),
    signedXmlDigest: createHash('sha256').update(signedXml).digest('hex'),
    attemptCount,
    signedXml,
  }
}

function simulator(scenario: SimulatorScenario, now = issuedAt + 30_000) {
  return new DeterministicNfce65Simulator(
    () => scenario,
    () => new Date(now),
  )
}

describe('model 65 simulated authority', () => {
  it('authorizes synchronously with a protocol instant within the emission window', async () => {
    const first = await simulator('authorized').submit(request(1))
    const again = await simulator('authorized', issuedAt + 3_600_000).submit(request(1))
    expect(first.outcome).toBe('authorized')
    expect(again.response).toEqual(first.response)
    const protocol = JSON.parse(first.protocol?.toString() ?? '{}')
    expect(protocol).toMatchObject({ model: '65', statusCode: '100', status: 'authorized' })
    expect(protocol.protocolNumber).toMatch(/^2\d{14}$/)
    expect(Date.parse(protocol.authorizedAt) - issuedAt).toBeLessThanOrEqual(60_000)
    expect(JSON.parse(first.response.toString())).toMatchObject({ synchronous: true })
  })

  it('rejects a document it first receives more than 5 minutes after dhEmi', async () => {
    const late = simulator('timeout-before-accept', issuedAt + NFCE_MAX_EMISSION_DELAY_MS + 1_000)
    expect((await late.submit(request(1))).outcome).toBe('unknown')
    expect((await late.consult(request(2))).outcome).toBe('not_found')
    const resent = await late.submit(request(3))
    expect(resent).toMatchObject({ outcome: 'rejected', rejectionCode: 'SIMULATED_LATE_EMISSION' })
    const inTime = simulator('timeout-before-accept', issuedAt + NFCE_MAX_EMISSION_DELAY_MS - 1_000)
    expect((await inTime.submit(request(3))).outcome).toBe('authorized')
  })

  it('answers a consultation with what it decided on the first receipt', async () => {
    const lost = simulator('timeout-after-accept', issuedAt + 3_600_000)
    expect((await lost.submit(request(1))).outcome).toBe('unknown')
    const consulted = await lost.consult(request(2))
    expect(consulted.outcome).toBe('authorized')
    const delayed = simulator('delayed-consultation')
    expect((await delayed.consult(request(2))).outcome).toBe('unknown')
    expect((await delayed.consult(request(3))).outcome).toBe('authorized')
    expect(await simulator('rejected').submit(request(1))).toMatchObject({
      outcome: 'rejected',
      rejectionCode: 'SIMULATED_REJECTION',
    })
  })

  it('refuses bytes that are not the recorded signed XML', async () => {
    await expect(
      simulator('authorized').submit({ ...request(1), signedXmlDigest: 'b'.repeat(64) }),
    ).rejects.toThrow('digest mismatch')
    const cancellation = await simulator('authorized').submitCancellation({
      commandId: randomUUID(),
      requestDigest: 'c'.repeat(64),
      eventXmlDigest: createHash('sha256').update('event').digest('hex'),
      attemptCount: 1,
      eventXml: Buffer.from('event'),
    })
    expect(cancellation.outcome).toBe('cancelled')
  })
})
