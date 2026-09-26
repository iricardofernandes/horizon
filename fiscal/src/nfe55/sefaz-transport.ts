import { createHash } from 'node:crypto'
import { request } from 'node:https'
import { z } from 'zod'
import type { HomologationCredential } from './homologation-credential'
import {
  authorizerOfEndpoints,
  SEFAZ_HOMOLOGATION_ENDPOINTS,
  SEFAZ_SERVICES,
  type SefazAuthorizer,
  type SefazEndpoints,
  type SefazService,
} from './sefaz-authorizers'
import { SefazServiceGate } from './sefaz-service-gate'
import type { SefazTrustAnchor } from './sefaz-trust-anchor'

export type { SefazEndpoints, SefazService } from './sefaz-authorizers'

/** Accepts only a URL published for that service by one reviewed authorizer. */
export function approvedSefazHomologationEndpoint(service: SefazService, value: string): URL {
  const endpoint = new URL(value)
  const approved = Object.values(SEFAZ_HOMOLOGATION_ENDPOINTS).some((set) => {
    const candidate = new URL(set[service])
    return (
      endpoint.protocol === 'https:' &&
      endpoint.hostname === candidate.hostname &&
      !endpoint.port &&
      !endpoint.username &&
      !endpoint.password &&
      !endpoint.search &&
      !endpoint.hash &&
      endpoint.pathname.toLowerCase() === candidate.pathname.toLowerCase()
    )
  })
  if (!approved) throw new Error(`Unapproved SEFAZ homologation endpoint for ${service}`)
  return endpoint
}

/** Digest bound into drill grants; an emulated route can never equal an official set. */
export function sefazEndpointSetDigest(
  endpoints: SefazEndpoints,
  route?: { host: string; port: number },
): string {
  const authorizer = authorizerOfEndpoints(endpoints)
  const urls = SEFAZ_SERVICES.map(
    (service) =>
      `${service}=${approvedSefazHomologationEndpoint(service, endpoints[service]).href}`,
  )
  return createHash('sha256')
    .update(
      `${route ? 'emulated-' : ''}sefaz-${authorizer.toLowerCase()}-homologation-endpoints-v1\n`,
    )
    .update(urls.join('\n'))
    .update(route ? `\nroute=${route.host}:${route.port}` : '')
    .digest('hex')
}

const loopbackRoute = z.strictObject({
  host: z.enum(['127.0.0.1', '::1']),
  port: z.number().int().min(1).max(65_535),
})

const settingsSchema = z.strictObject({
  timeoutMilliseconds: z.number().int().min(1_000).max(60_000).default(15_000),
  maximumResponseBytes: z.number().int().min(1_024).max(10_000_000).default(2_000_000),
  maximumConcurrentPerService: z.number().int().min(1).max(20).default(2),
  failureThreshold: z.number().int().min(1).max(20).default(3),
  cooldownMilliseconds: z.number().int().min(1_000).max(300_000).default(30_000),
  /**
   * Sends the official request bytes to a local SEFAZ emulator. TLS still verifies the
   * official hostname against the supplied trust anchor. The route changes the
   * endpoint digest and authority, so emulated exchanges can never be presented as
   * evidence from the official authorizer.
   */
  emulatorRoute: loopbackRoute.optional(),
})

/** A transport error leaves the authority outcome unknown, even if no bytes were received. */
export class SefazTransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SefazTransportError'
  }
}

export class SefazHomologationTransport {
  readonly authorizer: SefazAuthorizer
  readonly authority: 'official' | 'emulated'
  readonly endpointSetDigest: string
  readonly certificateFingerprint: string
  readonly trustAnchorFingerprint: string
  readonly #endpoints: Record<SefazService, URL>
  readonly #settings: z.infer<typeof settingsSchema>
  readonly #gate: SefazServiceGate

  constructor(
    endpoints: SefazEndpoints,
    private readonly credential: HomologationCredential,
    private readonly trustAnchor: SefazTrustAnchor,
    settings: z.input<typeof settingsSchema> = {},
  ) {
    this.#settings = settingsSchema.parse(settings)
    this.#gate = new SefazServiceGate({
      maximumConcurrent: this.#settings.maximumConcurrentPerService,
      failureThreshold: this.#settings.failureThreshold,
      cooldownMilliseconds: this.#settings.cooldownMilliseconds,
    })
    this.authorizer = authorizerOfEndpoints(endpoints)
    this.authority = this.#settings.emulatorRoute ? 'emulated' : 'official'
    this.#endpoints = Object.fromEntries(
      SEFAZ_SERVICES.map((service) => {
        return [service, approvedSefazHomologationEndpoint(service, endpoints[service])]
      }),
    ) as Record<SefazService, URL>
    this.endpointSetDigest = sefazEndpointSetDigest(endpoints, this.#settings.emulatorRoute)
    this.certificateFingerprint = credential.fingerprint
    this.trustAnchorFingerprint = trustAnchor.fingerprint
  }

  async send(service: SefazService, soapEnvelope: Buffer): Promise<Buffer> {
    if (Date.now() + this.credential.minimumRemainingMilliseconds >= this.credential.validUntil)
      throw new Error('Homologation certificate is no longer valid for transmission')
    if (soapEnvelope.length === 0 || soapEnvelope.length > 2_000_000)
      throw new Error('SEFAZ request size is outside the supported bound')
    const endpoint = this.#endpoints[service]
    if (!endpoint) throw new Error('SEFAZ service is not configured')
    return this.#gate.run(service, () => this.sendOnce(endpoint, soapEnvelope))
  }

  private sendOnce(endpoint: URL, soapEnvelope: Buffer): Promise<Buffer> {
    return sendSefazHttpsRequest(
      endpoint,
      soapEnvelope,
      this.credential,
      this.trustAnchor,
      this.#settings,
      this.#settings.emulatorRoute,
    )
  }
}

/** The network boundary is separate so local TLS tests exercise the exact send path. */
export function sendSefazHttpsRequest(
  endpoint: URL,
  soapEnvelope: Buffer,
  credential: Pick<HomologationCredential, 'certificate' | 'privateKey'>,
  trustAnchor: Pick<SefazTrustAnchor, 'certificate'>,
  settings: Pick<z.infer<typeof settingsSchema>, 'timeoutMilliseconds' | 'maximumResponseBytes'>,
  route?: z.infer<typeof loopbackRoute>,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const call = request(
      endpoint,
      {
        method: 'POST',
        // `hostname` from the URL outranks `host`; both must name the loopback route, or
        // the request would leave for the official authorizer's address.
        ...(route
          ? {
              host: route.host,
              hostname: route.host,
              port: route.port,
              servername: endpoint.hostname,
            }
          : {}),
        cert: credential.certificate,
        key: credential.privateKey,
        ca: trustAnchor.certificate,
        rejectUnauthorized: true,
        timeout: settings.timeoutMilliseconds,
        headers: {
          'content-type': 'application/soap+xml; charset=utf-8',
          'content-length': soapEnvelope.length,
          accept: 'application/soap+xml',
          ...(route ? { host: endpoint.hostname } : {}),
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          reject(new SefazTransportError(`SEFAZ returned HTTP ${response.statusCode ?? 0}`))
          return
        }
        const parts: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > settings.maximumResponseBytes) {
            response.destroy(new SefazTransportError('SEFAZ response exceeded the byte limit'))
            return
          }
          parts.push(chunk)
        })
        response.on('end', () => resolve(Buffer.concat(parts)))
        response.on('error', (error: Error) => reject(new SefazTransportError(error.message)))
      },
    )
    call.on('timeout', () => call.destroy(new SefazTransportError('SEFAZ request timed out')))
    call.on('error', (error: Error) => reject(new SefazTransportError(error.message)))
    call.end(soapEnvelope)
  })
}
