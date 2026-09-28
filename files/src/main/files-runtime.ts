import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { Attachments } from '@/application/attachments'
import { AttachmentLifecycle } from '@/application/lifecycle'
import type { Clock, ObjectStore, Scanner } from '@/application/ports'
import { AccessTokenVerifier } from '@/infrastructure/cryptography/access-token-verifier'
import { AesGcmEnvelope, masterKeyOf } from '@/infrastructure/cryptography/envelope'
import { FilesDatabase } from '@/infrastructure/database/drizzle/files-database'
import { AttachmentLinks } from '@/infrastructure/http/links'
import { ClamdScanner, EicarScanner } from '@/infrastructure/scanning/scanners'
import { FileObjectStore, S3ObjectStore } from '@/infrastructure/storage/object-stores'
import type { FilesEnvironment } from './environment'

function scannerOf(config: FilesEnvironment): Scanner {
  return config.FILES_SCANNER === 'clamav'
    ? new ClamdScanner(config.CLAMD_HOST, config.CLAMD_PORT, config.CLAMD_TIMEOUT_MS)
    : new EicarScanner()
}

function objectStoreOf(config: FilesEnvironment): ObjectStore {
  return config.FILES_STORE === 's3'
    ? new S3ObjectStore(config.FILES_BUCKET, {
        endpoint: config.FILES_S3_ENDPOINT,
        region: config.FILES_S3_REGION,
      })
    : new FileObjectStore(config.FILES_FILE_ROOT)
}

/** Explicit composition: every dependency is visible in one place. */
export class FilesRuntime implements OnModuleInit, OnModuleDestroy {
  readonly database: FilesDatabase
  readonly clock: Clock
  readonly accessTokens: AccessTokenVerifier
  readonly links: AttachmentLinks
  readonly attachments: Attachments
  readonly lifecycle: AttachmentLifecycle

  constructor(config: FilesEnvironment) {
    this.clock = { now: () => new Date() }
    this.database = new FilesDatabase({
      url: config.DATABASE_URL,
      poolMax: config.DATABASE_POOL_MAX,
      statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
    })
    this.accessTokens = new AccessTokenVerifier(
      config.JWKS_URL,
      config.ACCESS_TOKEN_MAX_AGE_SECONDS,
    )
    this.links = new AttachmentLinks(config.FILES_LINK_SECRET)
    const objects = objectStoreOf(config)
    this.attachments = new Attachments(
      this.database,
      objects,
      scannerOf(config),
      new AesGcmEnvelope(masterKeyOf(config.FILES_MASTER_KEY)),
      this.clock,
      { scanRetryMs: config.FILES_SCAN_RETRY_MS },
    )
    this.lifecycle = new AttachmentLifecycle(this.database, this.attachments, objects, this.clock, {
      batch: 20,
      claimMs: config.FILES_CLAIM_MS,
      scanRetryMs: config.FILES_SCAN_RETRY_MS,
    })
  }

  onModuleInit(): Promise<void> {
    return this.database.ping()
  }

  onModuleDestroy(): Promise<void> {
    return this.database.close()
  }
}
