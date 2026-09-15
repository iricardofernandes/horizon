import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { JaegerSource } from './sources/jaeger.js'
import type { LokiSource } from './sources/loki.js'
import type { PostgresSource } from './sources/postgres.js'
import type { PrometheusSource } from './sources/prometheus.js'
import type { RabbitMqSource } from './sources/rabbitmq.js'
import type { ToolExecutor } from './tool-executor.js'

export type ToolSources = {
  loki: LokiSource
  jaeger: JaegerSource
  prometheus: PrometheusSource
  rabbit: RabbitMqSource
  postgres: PostgresSource
}

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const

export function createDebuggerServer(
  caller: string,
  sources: ToolSources,
  executor: ToolExecutor,
): McpServer {
  const server = new McpServer({ name: 'horizon-mcp-debugger', version: '1.0.0' })
  const handler =
    <T>(name: string, operation: (args: T) => Promise<unknown>) =>
    async (args: T): Promise<CallToolResult> => {
      try {
        const result = await executor.run(caller, name, args, () => operation(args))
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: messageOf(error) }] }
      }
    }

  server.registerTool(
    'search_logs',
    {
      description: 'Search structured Loki logs without mutating the log store.',
      annotations,
      inputSchema: {
        module: z.string().min(1).optional(),
        level: z.string().min(1).optional(),
        traceId: z.string().min(1).optional(),
        text: z.string().max(200).optional(),
        minutes: z.number().int().min(1).max(1440).default(15),
        limit: z.number().int().min(1).max(500).default(100),
      },
    },
    handler(
      'search_logs',
      (args: {
        module?: string | undefined
        level?: string | undefined
        traceId?: string | undefined
        text?: string | undefined
        minutes: number
        limit: number
      }) => sources.loki.search(args),
    ),
  )

  server.registerTool(
    'get_trace',
    {
      description: 'Fetch a complete trace from Jaeger by trace id.',
      annotations,
      inputSchema: { traceId: z.string().regex(/^[a-fA-F0-9]{16,32}$/) },
    },
    handler('get_trace', (args: { traceId: string }) => sources.jaeger.getTrace(args.traceId)),
  )

  server.registerTool(
    'find_slow_traces',
    {
      description: 'Find traces at or above a latency percentile.',
      annotations,
      inputSchema: {
        service: z.string().min(1),
        operation: z.string().min(1).optional(),
        minutes: z.number().int().min(1).max(1440).default(60),
        percentile: z.number().min(50).max(100).default(95),
        limit: z.number().int().min(1).max(500).default(100),
      },
    },
    handler(
      'find_slow_traces',
      (args: {
        service: string
        operation?: string | undefined
        minutes: number
        percentile: number
        limit: number
      }) => sources.jaeger.findSlow(args),
    ),
  )

  server.registerTool(
    'get_recent_errors',
    {
      description: 'Group recent Loki error logs by exception type.',
      annotations,
      inputSchema: {
        minutes: z.number().int().min(1).max(1440).default(60),
        limit: z.number().int().min(1).max(500).default(200),
      },
    },
    handler('get_recent_errors', (args: { minutes: number; limit: number }) =>
      sources.loki.recentErrors(args.minutes, args.limit),
    ),
  )

  server.registerTool(
    'describe_schema',
    {
      description:
        'Describe tables, columns, indexes, constraints and RLS policies through a fixed pg_catalog wrapper.',
      annotations,
      inputSchema: {
        module: z.string().min(1),
        schema: z
          .string()
          .regex(/^[a-z_][a-z0-9_]*$/)
          .default('public'),
      },
    },
    handler('describe_schema', (args: { module: string; schema: string }) =>
      sources.postgres.describeSchema(args.module, args.schema),
    ),
  )

  server.registerTool(
    'explain_query',
    {
      description: 'Return EXPLAIN (ANALYZE false, FORMAT JSON) for one parse-validated SELECT.',
      annotations,
      inputSchema: { module: z.string().min(1), query: z.string().min(1).max(10_000) },
    },
    handler('explain_query', (args: { module: string; query: string }) =>
      sources.postgres.explain(args.module, args.query),
    ),
  )

  server.registerTool(
    'get_slow_queries',
    {
      description: 'Read normalized pg_stat_statements statistics; never query result rows.',
      annotations,
      inputSchema: {
        module: z.string().min(1),
        limit: z.number().int().min(1).max(100).default(20),
      },
    },
    handler('get_slow_queries', (args: { module: string; limit: number }) =>
      sources.postgres.slowQueries(args.module, args.limit),
    ),
  )

  server.registerTool(
    'list_dlq_messages',
    {
      description: 'List RabbitMQ dead-letter queue metadata without dequeuing messages.',
      annotations,
      inputSchema: {},
    },
    handler('list_dlq_messages', () => sources.rabbit.listDlqs()),
  )

  server.registerTool(
    'get_outbox_backlog',
    {
      description:
        'Return undispatched outbox counts and oldest age through a fixed aggregate wrapper.',
      annotations,
      inputSchema: { module: z.string().min(1).optional() },
    },
    handler('get_outbox_backlog', (args: { module?: string | undefined }) =>
      sources.postgres.outboxBacklog(args.module),
    ),
  )

  server.registerTool(
    'get_service_health',
    {
      description: 'Read RED and saturation metrics from Prometheus.',
      annotations,
      inputSchema: {
        service: z.string().min(1),
        minutes: z.number().int().min(1).max(1440).default(15),
      },
    },
    handler('get_service_health', (args: { service: string; minutes: number }) =>
      sources.prometheus.health(args.service, args.minutes),
    ),
  )

  return server
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown tool error'
}
