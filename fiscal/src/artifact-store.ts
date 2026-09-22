import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3'

export interface ObjectStore {
  writeOnce(key: string, bytes: Buffer): Promise<void>
  read(key: string): Promise<Buffer>
}

export interface FiscalArtifactStore {
  put(key: string, plaintext: Buffer): Promise<void>
  get(key: string): Promise<Buffer>
}

/** The key is a generated tenant/document/kind/digest path, never a user path. */
export class LocalObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}

  async writeOnce(key: string, bytes: Buffer): Promise<void> {
    assertObjectKey(key)
    const path = join(this.root, key)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${randomUUID()}.tmp`
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(bytes)
      await file.sync()
    } finally {
      await file.close()
    }
    try {
      await link(temporary, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    } finally {
      await unlink(temporary)
    }
  }

  async read(key: string): Promise<Buffer> {
    assertObjectKey(key)
    return readFile(join(this.root, key))
  }
}

export class S3ObjectStore implements ObjectStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async writeOnce(key: string, bytes: Buffer): Promise<void> {
    assertObjectKey(key)
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: bytes,
          IfNoneMatch: '*',
        }),
      )
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode
      if (status !== 409 && status !== 412) throw error
    }
  }

  async read(key: string): Promise<Buffer> {
    assertObjectKey(key)
    const object = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
    if (!object.Body) throw new Error('Fiscal artifact has no object body')
    return Buffer.from(await object.Body.transformToByteArray())
  }
}

/** AES-GCM binds encrypted bytes to their immutable tenant-scoped object key. */
export class EncryptedFiscalArtifactStore implements FiscalArtifactStore {
  constructor(
    private readonly objects: ObjectStore,
    private readonly key: Buffer,
  ) {
    if (key.length !== 32) throw new Error('Fiscal artifact encryption key must be 32 bytes')
  }

  async put(objectKey: string, plaintext: Buffer): Promise<void> {
    assertObjectKey(objectKey)
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce)
    cipher.setAAD(Buffer.from(objectKey))
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const packed = Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext])
    await this.objects.writeOnce(objectKey, packed)
    // A conditional put can lose a race to a prior writer. Verify its immutable bytes.
    const stored = await this.get(objectKey)
    if (!stored.equals(plaintext)) throw new Error('Fiscal artifact key contains different content')
  }

  async get(objectKey: string): Promise<Buffer> {
    assertObjectKey(objectKey)
    const packed = await this.objects.read(objectKey)
    if (packed.length < 29 || packed[0] !== 1) throw new Error('Invalid fiscal artifact envelope')
    const decipher = createDecipheriv('aes-256-gcm', this.key, packed.subarray(1, 13))
    decipher.setAAD(Buffer.from(objectKey))
    decipher.setAuthTag(packed.subarray(13, 29))
    return Buffer.concat([decipher.update(packed.subarray(29)), decipher.final()])
  }
}

function assertObjectKey(key: string): void {
  if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}\/(xml|response|protocol|pdf)\/[0-9a-f]{64}$/.test(key))
    throw new Error('Invalid fiscal artifact object key')
}
