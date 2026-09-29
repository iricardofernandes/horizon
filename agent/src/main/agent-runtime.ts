import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { AgentCalls } from '@/application/agent-calls'
import type { CallMetrics, Clock, Gateway, KeyExchange } from '@/application/ports'
import { AccessTokenVerifier } from '@/infrastructure/cryptography/access-token-verifier'
import { AgentDatabase } from '@/infrastructure/database/drizzle/agent-database'
import {
  HttpGateway,
  HttpKeyExchange,
  VerifiedKeyTokens,
} from '@/infrastructure/gateway/http-gateway'
import { OtelCallMetrics } from '@/infrastructure/observability/metrics'
import type { AgentEnvironment } from './environment'

/** What a test may put in place of the network: the exchange and the gateway. */
export interface AgentAdapters {
  readonly keys?: KeyExchange
  readonly gateway?: Gateway
  readonly metrics?: CallMetrics
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
  }

  onModuleInit(): Promise<void> {
    return this.database.ping()
  }

  onModuleDestroy(): Promise<void> {
    return this.database.close()
  }
}
