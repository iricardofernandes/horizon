import type { SefazService } from './sefaz-transport'

export type SefazServiceGateSettings = {
  maximumConcurrent: number
  failureThreshold: number
  cooldownMilliseconds: number
}

type ServiceState = {
  active: number
  failures: number
  openUntil: number
}

/** A local bound around one service; it never retries an ambiguous send. */
export class SefazServiceGate {
  readonly #states = new Map<SefazService, ServiceState>()

  constructor(
    private readonly settings: SefazServiceGateSettings,
    private readonly now: () => number = Date.now,
  ) {
    if (
      !Number.isInteger(settings.maximumConcurrent) ||
      settings.maximumConcurrent < 1 ||
      !Number.isInteger(settings.failureThreshold) ||
      settings.failureThreshold < 1 ||
      !Number.isInteger(settings.cooldownMilliseconds) ||
      settings.cooldownMilliseconds < 1
    )
      throw new Error('Invalid SEFAZ service gate settings')
  }

  async run<T>(service: SefazService, send: () => Promise<T>): Promise<T> {
    const state = this.#states.get(service) ?? { active: 0, failures: 0, openUntil: 0 }
    this.#states.set(service, state)
    if (state.openUntil > this.now()) throw new Error(`SEFAZ ${service} circuit is open`)
    if (state.active >= this.settings.maximumConcurrent)
      throw new Error(`SEFAZ ${service} concurrency limit reached`)
    state.active += 1
    try {
      const result = await send()
      state.failures = 0
      state.openUntil = 0
      return result
    } catch (error) {
      state.failures += 1
      if (state.failures >= this.settings.failureThreshold)
        state.openUntil = this.now() + this.settings.cooldownMilliseconds
      throw error
    } finally {
      state.active -= 1
    }
  }
}
