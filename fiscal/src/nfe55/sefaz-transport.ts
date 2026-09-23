import { request } from 'node:https'
import { z } from 'zod'
import type { HomologationCredential } from './homologation-credential'

export type SefazService = 'authorization' | 'receipt' | 'protocol' | 'status' | 'event'

const endpointNames: Record<SefazService, string> = {
  authorization: 'nfeautorizacao4.asmx',
  receipt: 'nferetautorizacao4.asmx',
  protocol: 'nfeconsultaprotocolo4.asmx',
  status: 'nfestatusservico4.asmx',
  event: 'nferecepcaoevento4.asmx',
}

export type SefazEndpoints = Record<SefazService, string>

const settingsSchema = z.strictObject({
  timeoutMilliseconds: z.number().int().min(1_000).max(60_000).default(15_000),
  maximumResponseBytes: z.number().int().min(1_024).max(10_000_000).default(2_000_000),
})

/** A transport error leaves the authority outcome unknown, even if no bytes were received. */
export class SefazTransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SefazTransportError'
  }
}

export class SefazHomologationTransport {
  readonly #endpoints: Record<SefazService, URL>
  readonly #settings: z.infer<typeof settingsSchema>

  constructor(
    endpoints: SefazEndpoints,
    private readonly credential: HomologationCredential,
    settings: z.input<typeof settingsSchema> = {},
  ) {
    this.#settings = settingsSchema.parse(settings)
    this.#endpoints = Object.fromEntries(
      (Object.keys(endpointNames) as SefazService[]).map((service) => {
        const endpoint = new URL(endpoints[service])
        if (
          endpoint.protocol !== 'https:' ||
          endpoint.hostname !== 'homologacao.nfe.fazenda.sp.gov.br' ||
          endpoint.port ||
          endpoint.username ||
          endpoint.password ||
          endpoint.search ||
          endpoint.hash ||
          endpoint.pathname.toLowerCase() !== `/ws/${endpointNames[service]}`
        )
          throw new Error(`Unapproved SEFAZ homologation endpoint for ${service}`)
        return [service, endpoint]
      }),
    ) as Record<SefazService, URL>
  }

  async send(service: SefazService, soapEnvelope: Buffer): Promise<Buffer> {
    if (Date.now() + this.credential.minimumRemainingMilliseconds >= this.credential.validUntil)
      throw new Error('Homologation certificate is no longer valid for transmission')
    if (soapEnvelope.length === 0 || soapEnvelope.length > 2_000_000)
      throw new Error('SEFAZ request size is outside the supported bound')
    const endpoint = this.#endpoints[service]
    if (!endpoint) throw new Error('SEFAZ service is not configured')
    return new Promise<Buffer>((resolve, reject) => {
      const call = request(
        endpoint,
        {
          method: 'POST',
          cert: this.credential.certificate,
          key: this.credential.privateKey,
          rejectUnauthorized: true,
          timeout: this.#settings.timeoutMilliseconds,
          headers: {
            'content-type': 'application/soap+xml; charset=utf-8',
            'content-length': soapEnvelope.length,
            accept: 'application/soap+xml',
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
            if (size > this.#settings.maximumResponseBytes) {
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
}
