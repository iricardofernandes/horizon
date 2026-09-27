import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { ObjectStore } from '@/application/ports/export-store'
import type { ExportFormat } from '@/domain/exports'
import { CONTENT_TYPES } from './writers'

/** Keys are generated (`exports/<tenant>/<job>.<ext>`); anything else is refused. */
const KEY = /^exports\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(csv|xlsx)$/

function checked(key: string): string {
  if (!KEY.test(key)) throw new Error('Refusing an object key that was not generated')
  return key
}

export class S3ObjectStore extends ObjectStore {
  private readonly client: S3Client

  constructor(
    private readonly bucket: string,
    options: { endpoint: string; region: string },
  ) {
    super()
    // Credentials come from the AWS environment variables, as for Fiscal.
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: true,
    })
  }

  async put(key: string, bytes: Buffer, format: ExportFormat): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: checked(key),
        Body: bytes,
        ContentType: CONTENT_TYPES[format],
      }),
    )
  }

  async get(key: string): Promise<Buffer> {
    const answer = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: checked(key) }),
    )
    if (!answer.Body) throw new Error('The export object has no body')
    return Buffer.from(await answer.Body.transformToByteArray())
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: checked(key) }))
  }
}

/** A directory, for tests and a single-machine setup. */
export class FileObjectStore extends ObjectStore {
  constructor(private readonly root: string) {
    super()
  }

  private path(key: string): string {
    return join(resolve(this.root), checked(key))
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const path = this.path(key)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, bytes, { mode: 0o600 })
  }

  get(key: string): Promise<Buffer> {
    return readFile(this.path(key))
  }

  async remove(key: string): Promise<void> {
    await rm(this.path(key), { force: true })
  }
}
