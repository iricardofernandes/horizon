import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  CopyObjectCommand,
  CreateBucketCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { EncryptedFiscalArtifactStore, S3ObjectStore } from '../src/artifact-store'

let container: StartedTestContainer
let client: S3Client

beforeAll(async () => {
  const accessKeyId = `fiscal${randomBytes(8).toString('hex')}`
  const secretAccessKey = randomBytes(24).toString('base64url')
  container = await new GenericContainer(
    // MinIO no longer publishes public images; this is a pinned community build from source.
    'pgsty/minio:RELEASE.2026-08-04T00-00-00Z@sha256:b6bfe7239bfc83fb90d31612d9704d86039dd714f7904b3f1ad68f211e602372',
  )
    .withEnvironment({
      MINIO_ROOT_USER: accessKeyId,
      MINIO_ROOT_PASSWORD: secretAccessKey,
    })
    .withCommand(['server', '/data'])
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000))
    .start()
  client = new S3Client({
    region: 'us-east-1',
    endpoint: `http://${container.getHost()}:${container.getMappedPort(9000)}`,
    forcePathStyle: true,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  })
  await client.send(new CreateBucketCommand({ Bucket: 'fiscal-artifact-tests' }))
  await client.send(
    new PutBucketVersioningCommand({
      Bucket: 'fiscal-artifact-tests',
      VersioningConfiguration: { Status: 'Enabled' },
    }),
  )
}, 120_000)

afterAll(async () => {
  client?.destroy()
  await container?.stop()
})

it('writes an encrypted S3 object once and recovers it with a new adapter', async () => {
  const keyMaterial = randomBytes(32)
  const bytes = Buffer.from('<NFe>simulated test artifact</NFe>')
  const digest = createHash('sha256').update(bytes).digest('hex')
  const key = `${randomUUID()}/${randomUUID()}/xml/${digest}`
  const objects = new S3ObjectStore(client, 'fiscal-artifact-tests')
  const encrypted = new EncryptedFiscalArtifactStore(objects, keyMaterial)
  await encrypted.put(key, bytes)
  await encrypted.put(key, bytes)
  expect((await objects.read(key)).includes(bytes)).toBe(false)
  const restarted = new EncryptedFiscalArtifactStore(
    new S3ObjectStore(client, 'fiscal-artifact-tests'),
    keyMaterial,
  )
  expect(await restarted.get(key)).toEqual(bytes)
  await expect(restarted.get(key.replace('/xml/', '/pdf/'))).rejects.toThrow()
  const versions = await client.send(
    new ListObjectVersionsCommand({
      Bucket: 'fiscal-artifact-tests',
      Prefix: key,
    }),
  )
  const original = versions.Versions?.find((item) => item.Key === key)?.VersionId
  if (!original) throw new Error('Versioned original artifact was not stored')
  await client.send(
    new PutObjectCommand({
      Bucket: 'fiscal-artifact-tests',
      Key: key,
      Body: Buffer.from('corrupted'),
    }),
  )
  await expect(restarted.get(key)).rejects.toThrow()
  await client.send(
    new CopyObjectCommand({
      Bucket: 'fiscal-artifact-tests',
      Key: key,
      CopySource: `fiscal-artifact-tests/${key}?versionId=${encodeURIComponent(original)}`,
    }),
  )
  expect(await restarted.get(key)).toEqual(bytes)
})
