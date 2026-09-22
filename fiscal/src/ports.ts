import { createHash } from 'node:crypto'

export interface Clock {
  now(): Date
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date()
  }
}

export interface CertificateProvider {
  load(secretReference: string): Promise<Buffer>
}

export interface RulePackageRepository {
  sourceDigest(packageId: string): Promise<string | null>
}

export type AuthorityRequest = {
  requestId: string
  tenantId: string
  documentId: string
  snapshotDigest: string
  number: number
}

export type AuthorityObservation = {
  outcome: 'authorized' | 'rejected' | 'unknown'
  providerReference: string | null
}

export interface AuthorityGateway {
  submit(request: AuthorityRequest): Promise<AuthorityObservation>
  consult(request: AuthorityRequest): Promise<AuthorityObservation>
  cancel(request: CancellationRequest): Promise<CancellationObservation>
  consultCancellation(request: CancellationRequest): Promise<CancellationObservation>
}

export type CancellationRequest = {
  requestId: string
  tenantId: string
  documentId: string
  reasonDigest: string
}

export type CancellationObservation = {
  outcome: 'cancelled' | 'rejected' | 'unknown'
  providerReference: string | null
}

/** Test-only transport with a stable result per request ID and optional first timeout. */
export class DeterministicAuthorityGateway implements AuthorityGateway {
  readonly #results = new Map<string, AuthorityObservation>()
  readonly #submitted = new Set<string>()
  readonly #cancellations = new Map<string, CancellationObservation>()
  readonly #cancelledOnce = new Set<string>()

  constructor(
    private readonly result: 'authorized' | 'rejected' = 'authorized',
    private readonly timeoutOnFirstSubmit = false,
  ) {}

  async submit(request: AuthorityRequest): Promise<AuthorityObservation> {
    const existing = this.#results.get(request.requestId)
    if (existing) return existing
    const reference = createHash('sha256').update(request.requestId).digest('hex').slice(0, 32)
    const outcome = { outcome: this.result, providerReference: `simulation:${reference}` } as const
    this.#results.set(request.requestId, outcome)
    if (this.timeoutOnFirstSubmit && !this.#submitted.has(request.requestId)) {
      this.#submitted.add(request.requestId)
      return { outcome: 'unknown', providerReference: null }
    }
    return outcome
  }

  async consult(request: AuthorityRequest): Promise<AuthorityObservation> {
    return this.#results.get(request.requestId) ?? { outcome: 'unknown', providerReference: null }
  }

  async cancel(request: CancellationRequest): Promise<CancellationObservation> {
    const existing = this.#cancellations.get(request.requestId)
    if (existing) return existing
    const reference = createHash('sha256').update(request.requestId).digest('hex').slice(0, 32)
    const outcome = { outcome: 'cancelled', providerReference: `simulation:${reference}` } as const
    this.#cancellations.set(request.requestId, outcome)
    if (this.timeoutOnFirstSubmit && !this.#cancelledOnce.has(request.requestId)) {
      this.#cancelledOnce.add(request.requestId)
      return { outcome: 'unknown', providerReference: null }
    }
    return outcome
  }

  async consultCancellation(request: CancellationRequest): Promise<CancellationObservation> {
    return (
      this.#cancellations.get(request.requestId) ?? { outcome: 'unknown', providerReference: null }
    )
  }
}

export class InMemoryCertificateProvider implements CertificateProvider {
  constructor(private readonly values: ReadonlyMap<string, Buffer>) {}
  async load(secretReference: string): Promise<Buffer> {
    const value = this.values.get(secretReference)
    if (!value) throw new Error('Certificate secret is unavailable')
    return Buffer.from(value)
  }
}

export class InMemoryRulePackageRepository implements RulePackageRepository {
  constructor(private readonly values: ReadonlyMap<string, string>) {}
  async sourceDigest(packageId: string): Promise<string | null> {
    return this.values.get(packageId) ?? null
  }
}
