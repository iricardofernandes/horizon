import { createHash, timingSafeEqual } from 'node:crypto'
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { NextFunction, Request, Response } from 'express'
import { type DebuggerConfig, readConfig } from './config.js'
import { JsonFileAuditSink } from './guardrails/audit-log.js'
import { Redactor } from './redaction/redactor.js'
import { createDebuggerServer, type ToolSources } from './server.js'
import { JaegerSource } from './sources/jaeger.js'
import { LokiSource } from './sources/loki.js'
import { PostgresSource } from './sources/postgres.js'
import { PrometheusSource } from './sources/prometheus.js'
import { RabbitMqSource } from './sources/rabbitmq.js'
import { ToolExecutor } from './tool-executor.js'

const config = readConfig()
if (!config.enabled) {
  process.stderr.write('Horizon MCP debugger is disabled (HORIZON_MCP_DEBUGGER_ENABLED=false).\n')
} else {
  await start(config)
}

async function start(config: Extract<DebuggerConfig, { enabled: true }>): Promise<void> {
  const sources: ToolSources = {
    loki: new LokiSource(config.lokiUrl),
    jaeger: new JaegerSource(config.jaegerUrl),
    prometheus: new PrometheusSource(config.prometheusUrl),
    rabbit: new RabbitMqSource(config.rabbitUrl, config.rabbitUser, config.rabbitPassword),
    postgres: new PostgresSource(config.databases),
  }
  const executor = new ToolExecutor(
    config.rateLimit,
    config.maxRows,
    config.maxBytes,
    new Redactor(config.tenantHashSalt, config.piiFields),
    new JsonFileAuditSink(config.auditLogPath),
  )

  if (config.transport === 'stdio') {
    const server = createDebuggerServer('stdio:local', sources, executor)
    await server.connect(new StdioServerTransport())
    return
  }

  const expectedToken = Buffer.from(config.bearerToken as string)
  const caller = `http:bearer:${createHash('sha256').update(expectedToken).digest('hex').slice(0, 12)}`
  const app = createMcpExpressApp({ host: config.httpHost, allowedHosts: [...config.allowedHosts] })
  app.use((request: Request, response: Response, next: NextFunction) => {
    const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? ''
    const candidate = Buffer.from(supplied)
    if (candidate.length !== expectedToken.length || !timingSafeEqual(candidate, expectedToken)) {
      response.status(401).json({ error: 'Unauthorized' })
      return
    }
    next()
  })
  app.post('/mcp', async (request: Request, response: Response) => {
    const server = createDebuggerServer(caller, sources, executor)
    const transport = new StreamableHTTPServerTransport()
    response.on('close', () => {
      void transport.close()
      void server.close()
    })
    try {
      // SDK 1.30's declaration omits exact-optional compatibility while the runtime
      // implements the Transport contract. Keep the cast at this one adapter edge.
      await server.connect(transport as Parameters<typeof server.connect>[0])
      await transport.handleRequest(request, response, request.body)
    } catch (error) {
      if (!response.headersSent)
        response
          .status(500)
          .json({ jsonrpc: '2.0', error: { code: -32603, message: messageOf(error) }, id: null })
    }
  })
  app.all('/mcp', (_request: Request, response: Response) => {
    response
      .status(405)
      .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null })
  })
  const listener = app.listen(config.httpPort, config.httpHost, () => {
    process.stderr.write(
      `Horizon MCP debugger listening on http://${config.httpHost}:${config.httpPort}/mcp\n`,
    )
  })
  const stop = async () => {
    listener.close()
    await sources.postgres.close()
  }
  process.once('SIGINT', () => void stop())
  process.once('SIGTERM', () => void stop())
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Internal server error'
}
