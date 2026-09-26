import { createHash } from 'node:crypto'
import { DOMParser } from '@xmldom/xmldom'
import { z } from 'zod'
import {
  type CancellationSimulatorResult,
  DeterministicNfe55Simulator,
  type SimulatorScenario,
} from '../nfe55/simulator'

/** NT 2025.001 §02.4: an NFC-e is expected to be authorized within 5 minutes of `dhEmi`. */
export const NFCE_MAX_EMISSION_DELAY_MS = 5 * 60_000

export type Nfce65SimulatorResult = {
  outcome: 'authorized' | 'rejected' | 'unknown' | 'not_found'
  providerCorrelation: string | null
  rejectionCode: 'SIMULATED_REJECTION' | 'SIMULATED_LATE_EMISSION' | null
  response: Buffer
  protocol: Buffer | null
}

const requestSchema = z.strictObject({
  commandId: z.uuid(),
  requestDigest: z.string().regex(/^[0-9a-f]{64}$/),
  signedXmlDigest: z.string().regex(/^[0-9a-f]{64}$/),
  attemptCount: z.number().int().positive(),
})

/**
 * The model 65 authority in simulation. Authorization is synchronous (one document, no
 * receipt). Outcomes depend on the command identity and, for a document the authority
 * first sees on a resend, on the resend instant, which is recorded in the response.
 * Cancellation is the same event service as model 55 and reuses its outcomes.
 */
export class DeterministicNfce65Simulator {
  readonly #cancellation: DeterministicNfe55Simulator

  constructor(
    private readonly chooseScenario: (requestDigest: string) => SimulatorScenario = defaultScenario,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#cancellation = new DeterministicNfe55Simulator(chooseScenario)
  }

  async submit(
    input: z.input<typeof requestSchema> & { signedXml: Buffer },
  ): Promise<Nfce65SimulatorResult> {
    const { signedXml, ...candidate } = input
    const request = requestSchema.parse(candidate)
    if (createHash('sha256').update(signedXml).digest('hex') !== request.signedXmlDigest)
      throw new Error('Simulator signed XML digest mismatch')
    const issuedAt = emissionInstant(signedXml)
    const scenario = this.chooseScenario(request.requestDigest)
    // The first send times out for every scenario except a prompt decision.
    if (request.attemptCount === 1 && scenario !== 'authorized' && scenario !== 'rejected')
      return unknown(request, scenario)
    // A resend after "timeout before accept" is the first time the authority sees it.
    const receivedAt =
      scenario === 'timeout-before-accept' ? this.now() : promptReceipt(issuedAt, request.commandId)
    return decide(request, scenario, issuedAt, receivedAt)
  }

  /** Consultation by access key: what the authority decided when it first received it. */
  async consult(input: z.input<typeof requestSchema> & { signedXml: Buffer }) {
    const { signedXml, ...candidate } = input
    const request = requestSchema.parse(candidate)
    const scenario = this.chooseScenario(request.requestDigest)
    if (scenario === 'timeout-before-accept' && request.attemptCount === 2)
      return result(request, scenario, 'not_found', null, null)
    if (scenario === 'delayed-consultation' && request.attemptCount < 3)
      return unknown(request, scenario)
    const issuedAt = emissionInstant(signedXml)
    return decide(request, scenario, issuedAt, promptReceipt(issuedAt, request.commandId))
  }

  submitCancellation(
    input: Parameters<DeterministicNfe55Simulator['submitCancellation']>[0],
  ): Promise<CancellationSimulatorResult> {
    return this.#cancellation.submitCancellation(input)
  }

  consultCancellation(
    input: Parameters<DeterministicNfe55Simulator['consultCancellation']>[0],
  ): Promise<CancellationSimulatorResult> {
    return this.#cancellation.consultCancellation(input)
  }
}

function decide(
  request: z.infer<typeof requestSchema>,
  scenario: SimulatorScenario,
  issuedAt: Date,
  receivedAt: Date,
): Nfce65SimulatorResult {
  if (scenario === 'rejected')
    return result(request, scenario, 'rejected', 'SIMULATED_REJECTION', receivedAt)
  if (receivedAt.getTime() - issuedAt.getTime() > NFCE_MAX_EMISSION_DELAY_MS)
    return result(request, scenario, 'rejected', 'SIMULATED_LATE_EMISSION', receivedAt)
  return result(request, scenario, 'authorized', null, receivedAt)
}

function unknown(
  request: z.infer<typeof requestSchema>,
  scenario: SimulatorScenario,
): Nfce65SimulatorResult {
  return result(request, scenario, 'unknown', null, null)
}

function result(
  request: z.infer<typeof requestSchema>,
  scenario: SimulatorScenario,
  outcome: Nfce65SimulatorResult['outcome'],
  rejectionCode: Nfce65SimulatorResult['rejectionCode'],
  receivedAt: Date | null,
): Nfce65SimulatorResult {
  const decided = outcome === 'authorized' || outcome === 'rejected'
  const providerCorrelation = decided
    ? `simulation:nfce:${createHash('sha256').update(request.commandId).digest('hex').slice(0, 32)}`
    : null
  const response = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      simulated: true,
      model: '65',
      synchronous: true,
      scenario,
      commandId: request.commandId,
      requestDigest: request.requestDigest,
      outcome,
      rejectionCode,
      receivedAt: receivedAt?.toISOString() ?? null,
      providerCorrelation,
    }),
  )
  const protocol = decided
    ? Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          simulated: true,
          model: '65',
          commandId: request.commandId,
          statusCode: outcome === 'authorized' ? '100' : '999',
          status: outcome,
          ...(outcome === 'authorized'
            ? {
                protocolNumber: protocolNumber(request.commandId),
                authorizedAt: receivedAt?.toISOString(),
              }
            : { rejectionCode }),
          providerCorrelation,
        }),
      )
    : null
  return { outcome, providerCorrelation, rejectionCode, response, protocol }
}

/** A document the authority received on its first send is decided within a minute. */
function promptReceipt(issuedAt: Date, commandId: string): Date {
  const seconds = createHash('sha256').update(commandId).digest().readUInt8(0) % 60
  return new Date(issuedAt.getTime() + (seconds + 1) * 1000)
}

function emissionInstant(signedXml: Buffer): Date {
  const node = new DOMParser()
    .parseFromString(signedXml.toString('utf8'), 'application/xml')
    .getElementsByTagName('dhEmi')
    .item(0)
  const value = node?.textContent?.trim()
  const instant = value ? Date.parse(value) : Number.NaN
  if (!Number.isFinite(instant)) throw new Error('Simulated NFC-e lacks a valid dhEmi')
  return new Date(instant)
}

function protocolNumber(commandId: string): string {
  // Model 65 protocols are distinguished from the model 55 simulator's leading 1.
  return `2${createHash('sha256')
    .update(commandId)
    .digest('hex')
    .slice(0, 14)
    .split('')
    .map((digit) => String(Number.parseInt(digit, 16) % 10))
    .join('')}`
}

function defaultScenario(requestDigest: string): SimulatorScenario {
  const bucket = Number.parseInt(requestDigest.at(-1) ?? '0', 16)
  if (bucket === 12) return 'timeout-before-accept'
  if (bucket === 13) return 'timeout-after-accept'
  if (bucket === 14) return 'delayed-consultation'
  if (bucket === 15) return 'rejected'
  return 'authorized'
}
