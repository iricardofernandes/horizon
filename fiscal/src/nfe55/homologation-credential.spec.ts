import { execFile } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpsServer } from 'node:https'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { connect, createServer, type TLSSocket } from 'node:tls'
import { promisify } from 'node:util'
import { afterAll, expect, it } from 'vitest'
import { loadHomologationCredential } from './homologation-credential'
import { SEFAZ_HOMOLOGATION_ENDPOINTS } from './sefaz-authorizers'
import {
  type SefazEndpoints,
  SefazHomologationTransport,
  sendSefazHttpsRequest,
} from './sefaz-transport'
import { loadSefazTrustAnchor } from './sefaz-trust-anchor'
import { fetchSefazWsdl } from './sefaz-wsdl'

const directories: string[] = []

afterAll(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })))
})

async function credential(issuerTaxId = '12345678000195', includeIssuer = true, duplicate = false) {
  const directory = await mkdtemp(join(tmpdir(), 'horizon-sefaz-credential-'))
  directories.push(directory)
  const certificatePath = join(directory, 'certificate.pem')
  const privateKeyPath = join(directory, 'private-key.pem')
  await promisify(execFile)('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '2',
    '-subj',
    '/CN=Horizon Homologation Transport Test Only',
    ...(includeIssuer
      ? [
          '-addext',
          `subjectAltName=DNS:localhost,otherName:2.16.76.1.3.3;PRINTABLE:${issuerTaxId}` +
            (duplicate ? `,otherName:2.16.76.1.3.3;PRINTABLE:${issuerTaxId}` : ''),
        ]
      : []),
    '-keyout',
    privateKeyPath,
    '-out',
    certificatePath,
  ])
  const parsed = new X509Certificate(await readFile(certificatePath))
  return {
    certificatePath,
    privateKeyPath,
    expectedFingerprint: createHash('sha256').update(parsed.raw).digest('hex'),
    expectedIssuerTaxId: issuerTaxId,
  }
}

it('loads only a matching, currently valid certificate and key', async () => {
  const input = await credential()
  const loaded = await loadHomologationCredential(input)
  const trust = await loadSefazTrustAnchor(input)
  expect(loaded.fingerprint).toBe(input.expectedFingerprint)
  expect(loaded.issuerTaxId).toBe(input.expectedIssuerTaxId)
  expect(trust.fingerprint).toBe(input.expectedFingerprint)
  const otherAnchor = await credential()
  const combinedPath = join(dirname(input.certificatePath), 'combined.pem')
  await writeFile(
    combinedPath,
    Buffer.concat([
      await readFile(input.certificatePath),
      await readFile(otherAnchor.certificatePath),
    ]),
  )
  const combined = await loadSefazTrustAnchor({
    certificatePath: combinedPath,
    expectedFingerprint: input.expectedFingerprint,
  })
  expect(combined.certificate.toString().match(/BEGIN CERTIFICATE/g)).toHaveLength(1)
  await expect(
    loadSefazTrustAnchor({ ...input, expectedFingerprint: '0'.repeat(64) }),
  ).rejects.toThrow('fingerprint mismatch')
  expect(loaded.validUntil).toBeGreaterThan(Date.now() + loaded.minimumRemainingMilliseconds)
  await expect(
    loadHomologationCredential({ ...input, expectedFingerprint: '0'.repeat(64) }),
  ).rejects.toThrow('fingerprint mismatch')
  await expect(
    loadHomologationCredential({ ...input, minimumRemainingMilliseconds: 3 * 86_400_000 }),
  ).rejects.toThrow('not currently valid')
  const other = await credential()
  await expect(
    loadHomologationCredential({ ...input, privateKeyPath: other.privateKeyPath }),
  ).rejects.toThrow('do not match')
  await expect(
    loadHomologationCredential({ ...input, expectedIssuerTaxId: '00000000000000' }),
  ).rejects.toThrow('issuer CNPJ mismatch')
  await expect(
    loadHomologationCredential(await credential('12345678000195', false)),
  ).rejects.toThrow('subject alternative name is missing')
  await expect(
    loadHomologationCredential(await credential('12345678000195', true, true)),
  ).rejects.toThrow('legal-entity CNPJ is missing or duplicate')
})

it('permits only the pinned SP homologation service paths', async () => {
  const input = await credential()
  const loaded = await loadHomologationCredential(input)
  const trust = await loadSefazTrustAnchor(input)
  const root = 'https://homologacao.nfe.fazenda.sp.gov.br/ws/'
  const endpoints: SefazEndpoints = {
    authorization: `${root}nfeautorizacao4.asmx`,
    receipt: `${root}nferetautorizacao4.asmx`,
    protocol: `${root}nfeconsultaprotocolo4.asmx`,
    status: `${root}nfestatusservico4.asmx`,
    event: `${root}nferecepcaoevento4.asmx`,
  }
  const transport = new SefazHomologationTransport(endpoints, loaded, trust)
  expect(transport.endpointSetDigest).toMatch(/^[0-9a-f]{64}$/)
  expect(transport.endpointSetDigest).toBe(
    new SefazHomologationTransport(endpoints, loaded, trust).endpointSetDigest,
  )
  expect(transport.certificateFingerprint).toBe(loaded.fingerprint)
  expect(transport.trustAnchorFingerprint).toBe(trust.fingerprint)
  await expect(
    new SefazHomologationTransport(
      endpoints,
      {
        ...loaded,
        validUntil: Date.now(),
      },
      trust,
    ).send('authorization', Buffer.from('<request/>')),
  ).rejects.toThrow('no longer valid')
  expect(
    () =>
      new SefazHomologationTransport(
        { ...endpoints, authorization: endpoints.authorization.replace('homologacao.', '') },
        loaded,
        trust,
      ),
  ).toThrow('Unapproved')
  expect(
    () =>
      new SefazHomologationTransport(
        { ...endpoints, event: endpoints.event.replace('https:', 'http:') },
        loaded,
        trust,
      ),
  ).toThrow('Unapproved')
})

it('selects the authorizer from the endpoint set and separates emulated routes', async () => {
  const input = await credential()
  const loaded = await loadHomologationCredential(input)
  const trust = await loadSefazTrustAnchor(input)
  const sp = new SefazHomologationTransport(SEFAZ_HOMOLOGATION_ENDPOINTS.SP, loaded, trust)
  // The SP digest keeps the formula bound to grants issued before other UFs existed.
  expect(sp.endpointSetDigest).toBe(
    createHash('sha256')
      .update('sefaz-sp-homologation-endpoints-v1\n')
      .update(
        (['authorization', 'receipt', 'protocol', 'status', 'event'] as const)
          .map((service) => `${service}=${SEFAZ_HOMOLOGATION_ENDPOINTS.SP[service]}`)
          .join('\n'),
      )
      .digest('hex'),
  )
  expect(sp).toMatchObject({ authorizer: 'SP', authority: 'official' })
  const svrs = new SefazHomologationTransport(SEFAZ_HOMOLOGATION_ENDPOINTS.SVRS, loaded, trust)
  expect(svrs.authorizer).toBe('SVRS')
  expect(svrs.endpointSetDigest).not.toBe(sp.endpointSetDigest)
  const emulated = new SefazHomologationTransport(
    SEFAZ_HOMOLOGATION_ENDPOINTS.SVRS,
    loaded,
    trust,
    {
      emulatorRoute: { host: '127.0.0.1', port: 9443 },
    },
  )
  expect(emulated.authority).toBe('emulated')
  expect(emulated.endpointSetDigest).not.toBe(svrs.endpointSetDigest)
  expect(
    () =>
      new SefazHomologationTransport(SEFAZ_HOMOLOGATION_ENDPOINTS.SVRS, loaded, trust, {
        emulatorRoute: { host: '10.0.0.1' as '127.0.0.1', port: 9443 },
      }),
  ).toThrow()
})

it('authenticates both peers with the mounted trust root and client certificate', async () => {
  const input = await credential()
  const loaded = await loadHomologationCredential(input)
  const trust = await loadSefazTrustAnchor(input)
  let clientAuthenticated = false
  const server = createServer(
    {
      cert: loaded.certificate,
      key: loaded.privateKey,
      ca: trust.certificate,
      requestCert: true,
      rejectUnauthorized: true,
    },
    (socket) => {
      clientAuthenticated = socket.authorized
      socket.end()
    },
  )
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Local TLS port unavailable')
    const client = connect({
      host: '127.0.0.1',
      port: address.port,
      servername: 'localhost',
      cert: loaded.certificate,
      key: loaded.privateKey,
      ca: trust.certificate,
      rejectUnauthorized: true,
    })
    await once(client, 'secureConnect')
    expect(client.authorized).toBe(true)
    await once(client, 'close')
    expect(clientAuthenticated).toBe(true)
    const untrusted = await loadSefazTrustAnchor(await credential())
    const rejected = connect({
      host: '127.0.0.1',
      port: address.port,
      servername: 'localhost',
      cert: loaded.certificate,
      key: loaded.privateKey,
      ca: untrusted.certificate,
      rejectUnauthorized: true,
    })
    await expect(once(rejected, 'secureConnect')).rejects.toThrow()
    rejected.destroy()
  } finally {
    server.close()
  }
})

it('sends SOAP over mutual TLS and rejects redirects, oversized replies and untrusted peers', async () => {
  const input = await credential()
  const loaded = await loadHomologationCredential(input)
  const trust = await loadSefazTrustAnchor(input)
  const otherTrust = await loadSefazTrustAnchor(await credential())
  const requestBytes = Buffer.from('<soap:Envelope>request</soap:Envelope>')
  let mode: 'success' | 'redirect' | 'oversized' | 'unavailable' | 'timeout' | 'reset' = 'success'
  let authenticatedRequests = 0
  const server = createHttpsServer(
    {
      cert: loaded.certificate,
      key: loaded.privateKey,
      ca: trust.certificate,
      requestCert: true,
      rejectUnauthorized: true,
    },
    async (request, response) => {
      if ((request.socket as TLSSocket).authorized) authenticatedRequests += 1
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      if (!Buffer.concat(chunks).equals(requestBytes) || request.method !== 'POST') {
        response.writeHead(400).end()
        return
      }
      if (mode === 'reset') {
        request.socket.destroy()
      } else if (mode === 'timeout') {
        return
      } else if (mode === 'unavailable') {
        response.writeHead(503).end()
      } else if (mode === 'redirect') {
        response.writeHead(302, { location: 'https://example.org/' }).end()
      } else if (mode === 'oversized') {
        response.writeHead(200, { 'content-type': 'application/soap+xml' })
        response.end(Buffer.alloc(1_025, 65))
      } else {
        response.writeHead(200, { 'content-type': 'application/soap+xml' })
        response.end('<soap:Envelope>response</soap:Envelope>')
      }
    },
  )
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Local HTTPS port unavailable')
    const endpoint = new URL(`https://localhost:${address.port}/ws/nfeautorizacao4.asmx`)
    const settings = { timeoutMilliseconds: 1_000, maximumResponseBytes: 1_024 }
    await expect(
      sendSefazHttpsRequest(endpoint, requestBytes, loaded, trust, settings),
    ).resolves.toEqual(Buffer.from('<soap:Envelope>response</soap:Envelope>'))
    expect(authenticatedRequests).toBe(1)
    mode = 'redirect'
    await expect(
      sendSefazHttpsRequest(endpoint, requestBytes, loaded, trust, settings),
    ).rejects.toThrow('HTTP 302')
    mode = 'oversized'
    await expect(
      sendSefazHttpsRequest(endpoint, requestBytes, loaded, trust, settings),
    ).rejects.toThrow('byte limit')
    mode = 'unavailable'
    await expect(
      sendSefazHttpsRequest(endpoint, requestBytes, loaded, trust, settings),
    ).rejects.toThrow('HTTP 503')
    mode = 'reset'
    await expect(
      sendSefazHttpsRequest(endpoint, requestBytes, loaded, trust, settings),
    ).rejects.toThrow()
    mode = 'timeout'
    await expect(
      sendSefazHttpsRequest(endpoint, requestBytes, loaded, trust, {
        ...settings,
        timeoutMilliseconds: 100,
      }),
    ).rejects.toThrow('timed out')
    await expect(
      sendSefazHttpsRequest(endpoint, requestBytes, loaded, otherTrust, settings),
    ).rejects.toThrow()
    expect(authenticatedRequests).toBe(6)
  } finally {
    server.closeAllConnections()
    server.close()
  }
})

it('fetches a bounded WSDL over mutual TLS and rejects redirects or non-WSDL bytes', async () => {
  const input = await credential()
  const loaded = await loadHomologationCredential(input)
  const trust = await loadSefazTrustAnchor(input)
  let mode: 'wsdl' | 'redirect' | 'html' | 'oversized' = 'wsdl'
  let authenticated = false
  const server = createHttpsServer(
    {
      cert: loaded.certificate,
      key: loaded.privateKey,
      ca: trust.certificate,
      requestCert: true,
      rejectUnauthorized: true,
    },
    (request, response) => {
      authenticated = (request.socket as TLSSocket).authorized
      if (request.method !== 'GET' || request.url !== '/ws/nfeautorizacao4.asmx?WSDL') {
        response.writeHead(400).end()
      } else if (mode === 'redirect') {
        response.writeHead(302, { location: 'https://example.org/' }).end()
      } else if (mode === 'html') {
        response.writeHead(200, { 'content-type': 'text/html' }).end('<html/>')
      } else if (mode === 'oversized') {
        response.writeHead(200, { 'content-type': 'text/xml' }).end(Buffer.alloc(2_000_001, 65))
      } else {
        response
          .writeHead(200, { 'content-type': 'text/xml' })
          .end('<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"/>')
      }
    },
  )
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Local HTTPS port unavailable')
    const endpoint = new URL(`https://localhost:${address.port}/ws/nfeautorizacao4.asmx`)
    await expect(fetchSefazWsdl(endpoint, loaded, trust)).resolves.toEqual(
      Buffer.from('<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"/>'),
    )
    expect(authenticated).toBe(true)
    mode = 'redirect'
    await expect(fetchSefazWsdl(endpoint, loaded, trust)).rejects.toThrow('HTTP 302')
    mode = 'html'
    await expect(fetchSefazWsdl(endpoint, loaded, trust)).rejects.toThrow('not a valid WSDL')
    mode = 'oversized'
    await expect(fetchSefazWsdl(endpoint, loaded, trust)).rejects.toThrow('byte limit')
    const untrusted = await loadSefazTrustAnchor(await credential())
    await expect(fetchSefazWsdl(endpoint, loaded, untrusted)).rejects.toThrow()
  } finally {
    server.closeAllConnections()
    server.close()
  }
})
