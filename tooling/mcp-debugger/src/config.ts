import { z } from 'zod'

const enabledSchema = z.enum(['true', 'false']).default('false')
const positive = z.coerce.number().int().positive()

export type DebuggerConfig =
  | { enabled: false }
  | {
      enabled: true
      transport: 'stdio' | 'http'
      httpHost: string
      httpPort: number
      allowedHosts: readonly string[]
      bearerToken?: string
      lokiUrl: string
      jaegerUrl: string
      prometheusUrl: string
      rabbitUrl: string
      rabbitUser: string
      rabbitPassword: string
      databases: ReadonlyMap<string, string>
      tenantHashSalt: string
      piiFields: ReadonlySet<string>
      maxRows: number
      maxBytes: number
      rateLimit: number
      auditLogPath: string
    }

const activeSchema = z.object({
  MCP_TRANSPORT: z.enum(['stdio', 'http']).default('stdio'),
  MCP_HTTP_HOST: z.string().min(1).default('127.0.0.1'),
  MCP_HTTP_PORT: positive.max(65_535).default(7801),
  MCP_ALLOWED_HOSTS: z.string().min(1).default('127.0.0.1,localhost'),
  MCP_BEARER_TOKEN: z.string().min(32).optional(),
  LOKI_URL: z.url(),
  JAEGER_URL: z.url(),
  PROMETHEUS_URL: z.url(),
  RABBITMQ_MANAGEMENT_URL: z.url(),
  RABBITMQ_MANAGEMENT_USER: z.string().min(1),
  RABBITMQ_MANAGEMENT_PASSWORD: z.string(),
  DEBUG_DATABASE_URLS: z.string().min(1),
  TENANT_ID_HASH_SALT: z.string().min(16),
  PII_MASK_FIELDS: z.string().min(1),
  MAX_RESULT_ROWS: positive.max(10_000).default(500),
  MAX_RESULT_BYTES: positive.max(1_048_576).default(262_144),
  RATE_LIMIT_PER_TOOL_PER_MINUTE: positive.max(600).default(30),
  AUDIT_LOG_PATH: z.string().min(1).default('./mcp-debugger-audit.log'),
})

export function readConfig(source: Record<string, unknown> = process.env): DebuggerConfig {
  const enabled = enabledSchema.parse(source.HORIZON_MCP_DEBUGGER_ENABLED) === 'true'
  if (!enabled) return { enabled: false }

  const value = activeSchema.parse(source)
  if (value.MCP_TRANSPORT === 'http' && !value.MCP_BEARER_TOKEN)
    throw new Error('MCP_BEARER_TOKEN is required for the HTTP transport')

  return {
    enabled: true,
    transport: value.MCP_TRANSPORT,
    httpHost: value.MCP_HTTP_HOST,
    httpPort: value.MCP_HTTP_PORT,
    allowedHosts: value.MCP_ALLOWED_HOSTS.split(',')
      .map((host) => host.trim())
      .filter(Boolean),
    ...(value.MCP_BEARER_TOKEN ? { bearerToken: value.MCP_BEARER_TOKEN } : {}),
    lokiUrl: withoutTrailingSlash(value.LOKI_URL),
    jaegerUrl: withoutTrailingSlash(value.JAEGER_URL),
    prometheusUrl: withoutTrailingSlash(value.PROMETHEUS_URL),
    rabbitUrl: withoutTrailingSlash(value.RABBITMQ_MANAGEMENT_URL),
    rabbitUser: value.RABBITMQ_MANAGEMENT_USER,
    rabbitPassword: value.RABBITMQ_MANAGEMENT_PASSWORD,
    databases: parseDatabases(value.DEBUG_DATABASE_URLS),
    tenantHashSalt: value.TENANT_ID_HASH_SALT,
    piiFields: new Set(
      value.PII_MASK_FIELDS.split(',')
        .map((field) => field.trim().toLowerCase())
        .filter(Boolean),
    ),
    maxRows: value.MAX_RESULT_ROWS,
    maxBytes: value.MAX_RESULT_BYTES,
    rateLimit: value.RATE_LIMIT_PER_TOOL_PER_MINUTE,
    auditLogPath: value.AUDIT_LOG_PATH,
  }
}

function parseDatabases(value: string): ReadonlyMap<string, string> {
  const entries = value.split(',').map((entry) => entry.trim().split('=', 2))
  const databases = new Map<string, string>()
  for (const [module, url] of entries) {
    if (!module || !/^[a-z][a-z0-9-]*$/.test(module) || !url)
      throw new Error('DEBUG_DATABASE_URLS must contain module=postgres-url pairs')
    const parsed = new URL(url)
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol))
      throw new Error(`Invalid debug database URL for ${module}`)
    databases.set(module, url)
  }
  if (databases.size === 0) throw new Error('At least one debug database is required')
  return databases
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/$/, '')
}
