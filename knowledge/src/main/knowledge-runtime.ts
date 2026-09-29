import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { Indexing } from '@/application/indexing'
import type { Clock, Embedder, FileSource } from '@/application/ports'
import { AccessTokenVerifier } from '@/infrastructure/cryptography/access-token-verifier'
import { AesGcmSealer, masterKeyOf } from '@/infrastructure/cryptography/sealer'
import { KnowledgeDatabase } from '@/infrastructure/database/knowledge-database'
import { HashEmbedder, TeiEmbedder } from '@/infrastructure/embedding/embedders'
import { FileTextExtractor } from '@/infrastructure/extraction/text-extractor'
import { GatewayFileSource } from '@/infrastructure/files/files-source'
import { OtelIndexMetrics } from '@/infrastructure/observability/metrics'
import type { KnowledgeEnvironment } from './environment'

/** What a test may put in place of the network: the file source and the embedder. */
export interface KnowledgeAdapters {
  readonly files?: FileSource
  readonly embedder?: Embedder
}

/** Explicit composition (ADR 0067): every dependency visible in one place. */
export class KnowledgeRuntime implements OnModuleInit, OnModuleDestroy {
  readonly database: KnowledgeDatabase
  readonly clock: Clock
  readonly accessTokens: AccessTokenVerifier
  readonly embedder: Embedder
  readonly sealer: AesGcmSealer
  readonly metrics: OtelIndexMetrics
  readonly indexing: Indexing

  constructor(config: KnowledgeEnvironment, adapters: KnowledgeAdapters = {}) {
    this.clock = { now: () => new Date() }
    this.database = new KnowledgeDatabase({
      url: config.DATABASE_URL,
      poolMax: config.DATABASE_POOL_MAX,
      statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
    })
    this.accessTokens = new AccessTokenVerifier(
      config.JWKS_URL,
      config.ACCESS_TOKEN_MAX_AGE_SECONDS,
    )
    this.embedder =
      adapters.embedder ??
      (config.KNOWLEDGE_EMBEDDER === 'tei' ? new TeiEmbedder(config.TEI_URL) : new HashEmbedder())
    this.sealer = new AesGcmSealer(masterKeyOf(config.KNOWLEDGE_MASTER_KEY))
    this.metrics = new OtelIndexMetrics()
    this.indexing = new Indexing(
      this.database,
      adapters.files ??
        new GatewayFileSource(
          config.GATEWAY_URL,
          config.SERVICE_TOKEN_SECRET,
          config.GATEWAY_TIMEOUT_MS,
        ),
      new FileTextExtractor(),
      this.embedder,
      this.sealer,
      this.clock,
      this.metrics,
      { leaseMs: config.KNOWLEDGE_LEASE_MS, batch: config.KNOWLEDGE_BATCH },
    )
  }

  onModuleInit(): Promise<void> {
    return this.database.ping()
  }

  onModuleDestroy(): Promise<void> {
    return this.database.close()
  }
}
