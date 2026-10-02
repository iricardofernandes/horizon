import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo, LookupFunction } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { failureOf } from '@/application/webhook-service'
import { EndpointRefusedError } from '@/domain/endpoint'
import { GuardedWebhookClient, guardedLookup, type Resolve } from './guarded-webhook-client'

const answering =
  (answers: Record<string, readonly string[]>): Resolve =>
  async (hostname) =>
    (answers[hostname] ?? []).map((address) => ({
      address,
      family: address.includes(':') ? 6 : 4,
    }))

function lookUp(lookup: LookupFunction, hostname: string, all: boolean) {
  return new Promise<unknown>((resolve, reject) =>
    lookup(hostname, { all }, (error, address) => (error ? reject(error) : resolve(address))),
  )
}

describe('the lookup a webhook connects through (Phase 90)', () => {
  it('lets only public addresses out, whatever the name resolved to before', async () => {
    const lookup = guardedLookup(
      answering({
        rebound: ['10.0.0.5'],
        mixed: ['10.0.0.5', '93.184.215.14', 'fd00::1', '2606:4700:4700::1111'],
      }),
      false,
    )
    await expect(lookUp(lookup, 'rebound', false)).rejects.toThrow(EndpointRefusedError)
    await expect(lookUp(lookup, 'rebound', true)).rejects.toThrow(EndpointRefusedError)
    await expect(lookUp(lookup, 'unknown', false)).rejects.toThrow(EndpointRefusedError)
    expect(await lookUp(lookup, 'mixed', false)).toBe('93.184.215.14')
    expect(await lookUp(lookup, 'mixed', true)).toEqual([
      { address: '93.184.215.14', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ])
  })

  it('lets loopback out only when a development stack calls its own loopback', async () => {
    const resolve = answering({ localhost: ['127.0.0.1', '::1', '10.0.0.5'] })
    await expect(lookUp(guardedLookup(resolve, false), 'localhost', false)).rejects.toThrow(
      EndpointRefusedError,
    )
    expect(await lookUp(guardedLookup(resolve, true), 'localhost', true)).toEqual([
      { address: '127.0.0.1', family: 4 },
      { address: '::1', family: 6 },
    ])
  })
})

describe('a delivery (Phase 90)', () => {
  const received: Array<{ method?: string; url?: string; body: string; signature?: string }> = []
  let server: Server
  let port: number

  beforeAll(async () => {
    server = createServer((request: IncomingMessage, response) => {
      let body = ''
      request.on('data', (chunk) => {
        body += chunk
      })
      request.on('end', () => {
        received.push({
          method: request.method,
          url: request.url,
          body,
          signature: request.headers['x-horizon-signature'] as string | undefined,
        })
        if (request.url === '/moved') {
          response.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' }).end()
          return
        }
        if (request.url === '/slow') return
        response.writeHead(204).end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })

  const post = (client: GuardedWebhookClient, url: string, timeoutMs = 2000) =>
    client.post({
      url,
      body: '{"eventId":"e"}',
      headers: { 'content-type': 'application/json', 'x-horizon-signature': 's' },
      timeoutMs,
    })

  it('reaches a development stack’s own loopback by name, when it says so', async () => {
    const client = new GuardedWebhookClient({
      allowLoopback: true,
      resolve: answering({ localhost: ['127.0.0.1'] }),
    })
    expect(await post(client, `http://localhost:${port}/events`)).toEqual({ status: 204 })
    expect(received.at(-1)).toMatchObject({
      method: 'POST',
      url: '/events',
      body: '{"eventId":"e"}',
      signature: 's',
    })
  })

  it('never connects to a name that now resolves to this machine', async () => {
    const before = received.length
    const client = new GuardedWebhookClient({
      resolve: answering({ 'hooks.example.com': ['127.0.0.1'] }),
    })
    const failure = await post(client, `https://hooks.example.com:${port}/events`).catch(
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(EndpointRefusedError)
    expect(failureOf(failure, null)).toBe('refused: not a public address')
    expect(received).toHaveLength(before)
  })

  it('refuses the loopback itself unless the stack allows it', async () => {
    const client = new GuardedWebhookClient()
    await expect(post(client, `http://127.0.0.1:${port}/events`)).rejects.toThrow(
      EndpointRefusedError,
    )
  })

  it('does not follow a redirect', async () => {
    const before = received.length
    const client = new GuardedWebhookClient({
      allowLoopback: true,
      resolve: answering({ localhost: ['127.0.0.1'] }),
    })
    expect(await post(client, `http://localhost:${port}/moved`)).toEqual({ status: 302 })
    expect(received).toHaveLength(before + 1)
  })

  it('gives up when the endpoint does not answer in time', async () => {
    const client = new GuardedWebhookClient({
      allowLoopback: true,
      resolve: answering({ localhost: ['127.0.0.1'] }),
    })
    const failure = await post(client, `http://localhost:${port}/slow`, 200).catch(
      (error: unknown) => error,
    )
    expect(failureOf(failure, null)).toBe('timeout')
  })
})
