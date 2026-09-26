import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { FiscalEstablishmentCredentials } from './establishment-credentials'
import { isBrazilianUf } from './nfe55/jurisdiction'
import {
  authorizerForUf,
  authorizerOfEndpoints,
  SEFAZ_HOMOLOGATION_ENDPOINTS,
} from './nfe55/sefaz-authorizers'
import { approvedSefazHomologationEndpoint, type SefazService } from './nfe55/sefaz-transport'
import { loadSefazTrustAnchor } from './nfe55/sefaz-trust-anchor'
import { fetchSefazWsdl } from './nfe55/sefaz-wsdl'
import { endpointsSchema } from './phase43-runtime-input'

function flag(name: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index < 0 ? undefined : process.argv[index + 1]
  if (!value) throw new Error(`--${name} is required`)
  return value
}

function optionalFlag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? undefined : process.argv[index + 1]
}

async function main(): Promise<void> {
  const databaseUrl = z.url().parse(process.env.DATABASE_URL)
  const key = Buffer.from(
    z
      .string()
      .regex(/^[0-9a-f]{64}$/i)
      .parse(process.env.FISCAL_ARTIFACT_KEY_HEX),
    'hex',
  )
  const tenantId = z.uuid().parse(flag('tenant'))
  const establishmentId = z.uuid().parse(flag('establishment'))
  const credentials = new FiscalEstablishmentCredentials(databaseUrl, key)
  const credential = await credentials.active(tenantId, establishmentId)
  await credentials.close()
  // The establishment's UF selects the authorizer; a mounted endpoint file may only confirm it.
  const uf = z.string().parse(flag('uf'))
  if (!isBrazilianUf(uf)) throw new Error('--uf must be a Brazilian UF')
  const authorizer = authorizerForUf(uf)
  const endpointsPath = optionalFlag('endpoints')
  const [trustAnchor, mountedEndpoints] = await Promise.all([
    loadSefazTrustAnchor({
      certificatePath: flag('trust-anchor'),
      expectedFingerprint: flag('trust-anchor-fingerprint'),
    }),
    endpointsPath
      ? readFile(endpointsPath, 'utf8').then((bytes) => endpointsSchema.parse(JSON.parse(bytes)))
      : null,
  ])
  if (mountedEndpoints && authorizerOfEndpoints(mountedEndpoints) !== authorizer)
    throw new Error('Mounted SEFAZ endpoints belong to another authorizer')
  const endpoints = SEFAZ_HOMOLOGATION_ENDPOINTS[authorizer]
  if (Date.now() + credential.minimumRemainingMilliseconds >= credential.validUntil)
    throw new Error('Homologation certificate is no longer valid for WSDL retrieval')
  const services: SefazService[] = ['authorization', 'receipt', 'protocol', 'status', 'event']
  const reviewedEndpoints = services.map((service) => ({
    service,
    url: approvedSefazHomologationEndpoint(service, endpoints[service]),
  }))
  const fetched = []
  for (const { service, url } of reviewedEndpoints) {
    const bytes = await fetchSefazWsdl(url, credential, trustAnchor)
    fetched.push({
      service,
      endpoint: url.href,
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  }
  const outputDirectory = resolve(z.string().min(1).parse(flag('output-directory')))
  const repositoryRoot = resolve(__dirname, '../..')
  const withinRepository = relative(repositoryRoot, outputDirectory)
  if (!withinRepository.startsWith('..') && !isAbsolute(withinRepository))
    throw new Error('SEFAZ WSDL output directory must be outside the repository')
  await mkdir(outputDirectory, { mode: 0o700 })
  try {
    const fetchedAt = new Date().toISOString()
    const wsdlSetDigest = createHash('sha256')
      .update(`sefaz-${authorizer.toLowerCase()}-homologation-wsdl-v1\n`)
      .update(fetched.map(({ service, sha256 }) => `${service}=${sha256}`).join('\n'))
      .digest('hex')
    for (const item of fetched)
      await writeFile(join(outputDirectory, `${item.service}.wsdl`), item.bytes, { mode: 0o600 })
    const manifest = {
      fetchedAt,
      environment: 'homologation',
      jurisdiction: uf,
      authorizer,
      certificateFingerprint: credential.fingerprint,
      trustAnchorFingerprint: trustAnchor.fingerprint,
      wsdlSetDigest,
      wsdl: fetched.map(({ service, endpoint, bytes, sha256 }) => ({
        service,
        endpoint,
        sha256,
        byteSize: bytes.length,
      })),
    }
    await writeFile(
      join(outputDirectory, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      {
        mode: 0o600,
      },
    )
    process.stdout.write(`${JSON.stringify(manifest)}\n`)
  } catch (error) {
    await rm(outputDirectory, { recursive: true, force: true })
    throw error
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'SEFAZ WSDL retrieval failed')
  process.exitCode = 1
})
