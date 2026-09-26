import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { SEFAZ_HOMOLOGATION_ENDPOINTS } from './nfe55/sefaz-authorizers'
import { SefazHomologationEmulator } from './nfe55/sefaz-emulator'
import { sefazEndpointSetDigest } from './nfe55/sefaz-transport'
import { authorizerSchema } from './phase43-runtime-input'

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? undefined : process.argv[index + 1]
}

function required(name: string): string {
  const value = flag(name)
  if (!value) throw new Error(`--${name} is required`)
  return value
}

/**
 * Runs a local NF-e homologation authorizer for simulation environments. Point the
 * worker's `emulatorRoute` (or `phase43:exchange-resume --emulator`) at the printed
 * port; its exchanges are recorded as `emulated` and cannot activate a capability.
 */
async function main(): Promise<void> {
  if (process.env.FISCAL_ALLOW_SEFAZ_EMULATOR !== 'true')
    throw new Error('The SEFAZ emulator requires FISCAL_ALLOW_SEFAZ_EMULATOR=true')
  const authorizer = authorizerSchema.parse(required('authorizer'))
  const scenario = z
    .enum(['authorize', 'reject', 'unreviewed', 'lose-response', 'unavailable'])
    .parse(flag('scenario') ?? 'authorize')
  const port = z.coerce
    .number()
    .int()
    .min(0)
    .max(65_535)
    .parse(flag('port') ?? '0')
  const emulator = new SefazHomologationEmulator(
    authorizer,
    {
      certificate: await readFile(required('certificate')),
      privateKey: await readFile(required('private-key')),
    },
    () => scenario,
  )
  const route = await emulator.listen(port)
  const endpointSetDigest = sefazEndpointSetDigest(SEFAZ_HOMOLOGATION_ENDPOINTS[authorizer], route)
  process.stdout.write(`${JSON.stringify({ authorizer, scenario, ...route, endpointSetDigest })}\n`)
  const stop = () => {
    void emulator.close().then(() => process.exit(0))
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'SEFAZ emulator failed')
  process.exitCode = 1
})
