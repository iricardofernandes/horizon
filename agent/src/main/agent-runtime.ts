import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { AgentCalls } from '@/application/agent-calls'
import { Assistant } from '@/application/assistant'
import type { AssistantMetrics } from '@/application/assistant-ports'
import type { Generator } from '@/application/generation'
import type { CallMetrics, Clock, Gateway, KeyExchange } from '@/application/ports'
import { AccessTokenVerifier } from '@/infrastructure/cryptography/access-token-verifier'
import { AesGcmTurnSealer, masterKeyOf } from '@/infrastructure/cryptography/turn-sealer'
import { AssistantDatabase } from '@/infrastructure/database/assistant-database'
import { AgentDatabase } from '@/infrastructure/database/drizzle/agent-database'
import {
  HttpGateway,
  HttpKeyExchange,
  VerifiedKeyTokens,
} from '@/infrastructure/gateway/http-gateway'
import { AnthropicGenerator } from '@/infrastructure/generation/anthropic-generator'
import { ExtractiveGenerator } from '@/infrastructure/generation/extractive-generator'
import { OtelAssistantMetrics, OtelCallMetrics } from '@/infrastructure/observability/metrics'
import type { AgentEnvironment } from './environment'

/** What a test may put in place of the network: the exchange and the gateway. */
export interface AgentAdapters {
  readonly keys?: KeyExchange
  readonly gateway?: Gateway
  readonly metrics?: CallMetrics
  readonly generator?: Generator
  readonly assistantMetrics?: AssistantMetrics
}

/**
 * Explicit composition (ADR 0065). The agent holds a database for its switch and its log,
 * Identity's public keys, and the gateway's address — and no credential of its own.
 */
export class AgentRuntime implements OnModuleInit, OnModuleDestroy {
  readonly database: AgentDatabase
  readonly clock: Clock
  readonly accessTokens: AccessTokenVerifier
  readonly calls: AgentCalls
  readonly assistantDatabase: AssistantDatabase
  readonly generator: Generator
  readonly assistant: Assistant

  constructor(config: AgentEnvironment, adapters: AgentAdapters = {}) {
    this.clock = { now: () => new Date() }
    this.database = new AgentDatabase({
      url: config.DATABASE_URL,
      poolMax: config.DATABASE_POOL_MAX,
      statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
    })
    this.accessTokens = new AccessTokenVerifier(
      config.JWKS_URL,
      config.ACCESS_TOKEN_MAX_AGE_SECONDS,
    )
    this.calls = new AgentCalls(
      this.database,
      adapters.keys ?? new HttpKeyExchange(config.GATEWAY_URL, config.GATEWAY_TIMEOUT_MS),
      new VerifiedKeyTokens(this.accessTokens),
      adapters.gateway ?? new HttpGateway(config.GATEWAY_URL, config.GATEWAY_TIMEOUT_MS),
      this.clock,
      adapters.metrics ?? new OtelCallMetrics(),
      { maxRows: config.AGENT_MAX_ROWS, maxBytes: config.AGENT_MAX_RESULT_BYTES },
    )
    this.assistantDatabase = new AssistantDatabase(config.DATABASE_URL, this.database, {
      statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
    })
    this.generator =
      adapters.generator ??
      (config.ASSISTANT_GENERATOR === 'anthropic'
        ? new AnthropicGenerator({
            apiKey: config.ANTHROPIC_API_KEY,
            model: config.ASSISTANT_MODEL,
            baseUrl: config.ANTHROPIC_BASE_URL,
            timeoutMs: config.ASSISTANT_TIMEOUT_MS,
          })
        : new ExtractiveGenerator())
    this.assistant = new Assistant(
      this.assistantDatabase,
      this.database,
      this.generator,
      adapters.gateway ?? new HttpGateway(config.GATEWAY_URL, config.GATEWAY_TIMEOUT_MS),
      new AesGcmTurnSealer(masterKeyOf(config.ASSISTANT_MASTER_KEY)),
      this.clock,
      adapters.assistantMetrics ?? new OtelAssistantMetrics(),
    )
  }

  onModuleInit(): Promise<void> {
    return this.database.ping()
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.database.close(), this.assistantDatabase.close()])
  }
}
