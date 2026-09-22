import { createHash } from 'node:crypto'
import { z } from 'zod'

export type SimulatorScenario =
  | 'authorized'
  | 'rejected'
  | 'timeout-before-accept'
  | 'timeout-after-accept'
  | 'delayed-consultation'

export type SimulatorResult = {
  outcome: 'authorized' | 'rejected' | 'unknown' | 'not_found'
  providerCorrelation: string | null
  response: Buffer
  protocol: Buffer | null
}

const requestSchema = z.strictObject({
  commandId: z.uuid(),
  requestDigest: z.string().regex(/^[0-9a-f]{64}$/),
  signedXmlDigest: z.string().regex(/^[0-9a-f]{64}$/),
  attemptCount: z.number().int().positive(),
})

/** Outcomes depend only on the persisted command identity, so restarts cannot change them. */
export class DeterministicNfe55Simulator {
  constructor(
    private readonly chooseScenario: (requestDigest: string) => SimulatorScenario = defaultScenario,
  ) {}

  async submit(
    input: z.input<typeof requestSchema> & { signedXml: Buffer },
  ): Promise<SimulatorResult> {
    const { signedXml, ...candidate } = input
    const request = requestSchema.parse(candidate)
    const actualDigest = createHash('sha256').update(signedXml).digest('hex')
    if (actualDigest !== request.signedXmlDigest)
      throw new Error('Simulator signed XML digest mismatch')
    const scenario = this.chooseScenario(request.requestDigest)
    if (
      request.attemptCount === 1 &&
      (scenario === 'timeout-before-accept' ||
        scenario === 'timeout-after-accept' ||
        scenario === 'delayed-consultation')
    )
      return result(request, scenario, 'unknown', null)
    return finalResult(request, scenario)
  }

  async consult(input: z.input<typeof requestSchema>): Promise<SimulatorResult> {
    const request = requestSchema.parse(input)
    const scenario = this.chooseScenario(request.requestDigest)
    if (scenario === 'timeout-before-accept' && request.attemptCount === 2)
      return result(request, scenario, 'not_found', null)
    if (scenario === 'delayed-consultation' && request.attemptCount < 3)
      return result(request, scenario, 'unknown', null)
    return finalResult(request, scenario)
  }
}

function finalResult(
  request: z.infer<typeof requestSchema>,
  scenario: SimulatorScenario,
): SimulatorResult {
  const outcome = scenario === 'rejected' ? 'rejected' : 'authorized'
  const correlation = `simulation:${createHash('sha256').update(request.commandId).digest('hex').slice(0, 32)}`
  return result(request, scenario, outcome, correlation)
}

function result(
  request: z.infer<typeof requestSchema>,
  scenario: SimulatorScenario,
  outcome: SimulatorResult['outcome'],
  providerCorrelation: string | null,
): SimulatorResult {
  const response = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      simulated: true,
      scenario,
      commandId: request.commandId,
      requestDigest: request.requestDigest,
      outcome,
      providerCorrelation,
    }),
  )
  const protocol =
    outcome === 'authorized' || outcome === 'rejected'
      ? Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            simulated: true,
            commandId: request.commandId,
            statusCode: outcome === 'authorized' ? '100' : '999',
            status: outcome,
            providerCorrelation,
          }),
        )
      : null
  return { outcome, providerCorrelation, response, protocol }
}

function defaultScenario(requestDigest: string): SimulatorScenario {
  const bucket = Number.parseInt(requestDigest.at(-1) ?? '0', 16)
  if (bucket === 12) return 'timeout-before-accept'
  if (bucket === 13) return 'timeout-after-accept'
  if (bucket === 14) return 'delayed-consultation'
  if (bucket === 15) return 'rejected'
  return 'authorized'
}
