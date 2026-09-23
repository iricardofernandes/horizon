import { S3Client } from '@aws-sdk/client-s3'
import { z } from 'zod'
import { EncryptedFiscalArtifactStore, S3ObjectStore } from './artifact-store'
import { FiscalArtifacts } from './artifacts'
import { HomologationObservations } from './homologation-observations'
import { HomologationRestoreVerifier } from './homologation-restore-verifier'
import { digestSchema } from './phase43-runtime-input'

function flag(name: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index < 0 ? undefined : process.argv[index + 1]
  if (!value) throw new Error(`--${name} is required`)
  return value
}

async function main(): Promise<void> {
  const databaseUrl = z.url().parse(process.env.DATABASE_URL)
  const key = Buffer.from(
    digestSchema.parse(process.env.FISCAL_ARTIFACT_KEY_HEX?.toLowerCase()),
    'hex',
  )
  const bucket = z.string().min(3).parse(process.env.FISCAL_ARTIFACT_BUCKET)
  const region = z.string().min(1).parse(process.env.FISCAL_ARTIFACT_REGION)
  const endpoint = process.env.FISCAL_ARTIFACT_ENDPOINT || undefined
  const tenantId = z.uuid().parse(flag('tenant'))
  const documentId = z.uuid().parse(flag('document'))
  const s3 = new S3Client({
    region,
    forcePathStyle: Boolean(endpoint),
    ...(endpoint ? { endpoint } : {}),
  })
  const artifacts = new FiscalArtifacts(
    databaseUrl,
    new EncryptedFiscalArtifactStore(new S3ObjectStore(s3, bucket), key),
  )
  const observations = new HomologationObservations(databaseUrl)
  const verifier = new HomologationRestoreVerifier(databaseUrl, artifacts, observations)
  try {
    process.stdout.write(
      `${JSON.stringify(await verifier.verify(tenantId, documentId), null, 2)}\n`,
    )
  } finally {
    await Promise.all([verifier.close(), observations.close(), artifacts.close()])
    s3.destroy()
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Phase 43 restore verification failed')
  process.exitCode = 1
})
