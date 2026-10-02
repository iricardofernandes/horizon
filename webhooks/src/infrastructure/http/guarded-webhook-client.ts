import { promises as dns } from 'node:dns'
import { Agent as HttpAgent, request as httpRequest } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import type { EndpointResolver, WebhookHttpClient } from '@/application/webhook-service'
import {
  checkEndpoint,
  EndpointRefusedError,
  isLoopbackHost,
  isPublicAddress,
} from '@/domain/endpoint'

const IDLE_SOCKET_MS = 5_000

type Resolved = { address: string; family: number }
export type Resolve = (hostname: string) => Promise<readonly Resolved[]>

const systemResolve: Resolve = (hostname) => dns.lookup(hostname, { all: true, verbatim: true })

const isLoopbackAddress = (address: string): boolean =>
  address === '::1' || (isIP(address) === 4 && address.startsWith('127.'))

/**
 * The lookup a webhook's socket connects through: only public addresses come out of it, and
 * loopback ones too when a development stack calls its own loopback by name.
 */
export function guardedLookup(resolve: Resolve, allowLoopbackAddresses: boolean): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        const usable = addresses.filter(
          (entry) =>
            isPublicAddress(entry.address) ||
            (allowLoopbackAddresses && isLoopbackAddress(entry.address)),
        )
        const first = usable[0]
        if (!first) {
          callback(new EndpointRefusedError('The endpoint must be a public address'), '', 0)
          return
        }
        if (options.all) callback(null, [...usable])
        else callback(null, first.address, first.family)
      },
      (error: unknown) => callback(error as NodeJS.ErrnoException, '', 0),
    )
  }
}

/**
 * Posts a webhook to the public internet only (Phase 90). The address is checked when the
 * connection is made, from the very lookup the socket uses, so a name that resolved to a
 * public address when the subscription was made and resolves to a private one now is
 * refused now. Redirects are not followed: a 3xx is a failed attempt. The agents are its own,
 * so no connection another part of the process opened, unchecked, is ever reused here.
 */
export class GuardedWebhookClient implements WebhookHttpClient {
  private readonly allowLoopback: boolean
  private readonly resolve: Resolve
  // An idle connection is closed after 5 s, as Node's own global agent does, so no
  // endpoint can hold one open indefinitely.
  private readonly httpAgent = new HttpAgent({ keepAlive: true, timeout: IDLE_SOCKET_MS })
  private readonly httpsAgent = new HttpsAgent({ keepAlive: true, timeout: IDLE_SOCKET_MS })

  constructor(options: { allowLoopback?: boolean; resolve?: Resolve } = {}) {
    this.allowLoopback = options.allowLoopback ?? false
    this.resolve = options.resolve ?? systemResolve
  }

  async post(input: {
    url: string
    body: string
    headers: Readonly<Record<string, string>>
    timeoutMs: number
  }): Promise<{ status: number }> {
    const url = checkEndpoint(input.url, this.allowLoopback)
    const lookup = guardedLookup(this.resolve, this.allowLoopback && isLoopbackHost(url.hostname))
    const secure = url.protocol === 'https:'
    const send = secure ? httpsRequest : httpRequest
    return new Promise((resolve, reject) => {
      const request = send(
        url,
        {
          method: 'POST',
          agent: secure ? this.httpsAgent : this.httpAgent,
          headers: { ...input.headers, 'content-length': Buffer.byteLength(input.body) },
          lookup,
          signal: AbortSignal.timeout(input.timeoutMs),
        },
        (response) => {
          response.resume()
          resolve({ status: response.statusCode ?? 0 })
        },
      )
      request.on('error', reject)
      request.end(input.body)
    })
  }
}

/** Resolves a host for the subscription-time check; a name that does not resolve is []. */
export class SystemEndpointResolver implements EndpointResolver {
  constructor(private readonly resolve: Resolve = systemResolve) {}

  async addressesOf(hostname: string): Promise<readonly string[]> {
    try {
      return (await this.resolve(hostname)).map((entry) => entry.address)
    } catch (error) {
      const code = (error as { code?: unknown }).code
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ENODATA') return []
      throw error
    }
  }
}
