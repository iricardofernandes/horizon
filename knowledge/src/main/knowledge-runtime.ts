import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { Indexing } from '@/application/indexing'
import { Lexemes } from '@/application/lexemes'
import type { Clock, Embedder, FileSource } from '@/application/ports'
import { Search } from '@/application/search'
import type { PayableSource } from '@/application/suggestion-ports'
import { ExampleIndex, NcmTableLoader, Suggestions } from '@/application/suggestions'
import { AccessTokenVerifier } from '@/infrastructure/cryptography/access-token-verifier'
import { HmacLexemeHasher } from '@/infrastructure/cryptography/lexeme-hasher'
import { AesGcmSealer, masterKeyOf } from '@/infrastructure/cryptography/sealer'
import { ExampleDatabase } from '@/infrastructure/database/example-database'
import { KnowledgeDatabase } from '@/infrastructure/database/knowledge-database'
import { HashEmbedder, TeiEmbedder } from '@/infrastructure/embedding/embedders'
import { FileTextExtractor } from '@/infrastructure/extraction/text-extractor'
import { GatewayFileSource } from '@/infrastructure/files/files-source'
import { ServiceGateway } from '@/infrastructure/gateway/service-gateway'
import { OtelIndexMetrics } from '@/infrastructure/observability/metrics'
import { GatewayPayableSource } from '@/infrastructure/suggestions/payable-source'
import type { KnowledgeEnvironment } from './environment'

/** What a test may put in place of the network: the file source and the embedder. */
export interface KnowledgeAdapters {
  readonly files?: FileSource
  readonly embedder?: Embedder
  readonly payables?: PayableSource
}

/** Suggestions answer with the local model, unless configuration forces them on or off. */
export const suggestionsOn = (config: KnowledgeEnvironment) =>
  config.KNOWLEDGE_SUGGESTIONS === 'on' ||
  (config.KNOWLEDGE_SUGGESTIONS === 'auto' && config.KNOWLEDGE_EMBEDDER === 'tei')

/** Explicit composition (ADR 0067): every dependency visible in one place. */
export class KnowledgeRuntime implements OnModuleInit, OnModuleDestroy {
  readonly database: KnowledgeDatabase
  readonly clock: Clock
  readonly accessTokens: AccessTokenVerifier
  readonly embedder: Embedder
  readonly sealer: AesGcmSealer
  readonly metrics: OtelIndexMetrics
  readonly indexing: Indexing
  readonly search: Search
  readonly examples: ExampleDatabase
  readonly exampleIndex: ExampleIndex
  readonly ncmTable: NcmTableLoader
  readonly suggestions: Suggestions

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
    const gateway = new ServiceGateway(
      config.GATEWAY_URL,
      config.SERVICE_TOKEN_SECRET,
      config.GATEWAY_TIMEOUT_MS,
    )
    const masterKey = masterKeyOf(config.KNOWLEDGE_MASTER_KEY)
    this.sealer = new AesGcmSealer(masterKey)
    const lexemes = new Lexemes(this.database, new HmacLexemeHasher(masterKey))
    this.metrics = new OtelIndexMetrics()
    this.indexing = new Indexing(
      this.database,
      adapters.files ?? new GatewayFileSource(gateway),
      new FileTextExtractor(),
      this.embedder,
      this.sealer,
      lexemes,
      this.clock,
      this.metrics,
      { leaseMs: config.KNOWLEDGE_LEASE_MS, batch: config.KNOWLEDGE_BATCH },
    )
    this.search = new Search(this.database, this.embedder, lexemes, this.sealer, this.metrics)
    this.examples = new ExampleDatabase(config.DATABASE_URL, {
      statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
    })
    this.exampleIndex = new ExampleIndex(
      this.examples,
      adapters.payables ?? new GatewayPayableSource(gateway),
      this.embedder,
      this.clock,
    )
    this.ncmTable = new NcmTableLoader(this.examples, this.embedder, this.clock)
    this.suggestions = new Suggestions(
      this.examples,
      this.embedder,
      this.metrics,
      suggestionsOn(config),
    )
  }

  onModuleInit(): Promise<void> {
    return this.database.ping()
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.database.close(), this.examples.close()])
  }
}
