import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { z } from 'zod'
import { EMPTY_METRICS, type ProbeMetricsState, recordRun, renderMetrics } from './metrics.js'
import { type Http, runProbe } from './probe.js'

const environment = z
  .object({
    /** The gateway: the probe walks the path a person's browser would. */
    PROBE_BASE_URL: z.url().default('http://kong:8000'),
    PROBE_EMAIL: z.email(),
    PROBE_PASSWORD: z.string().min(12),
    PROBE_TENANT_ID: z.uuid().optional(),
    PROBE_INTERVAL_SECONDS: z.coerce.number().int().min(15).default(60),
    PROBE_TIMEOUT_SECONDS: z.coerce.number().int().min(1).default(10),
    PROBE_METRICS_PORT: z.coerce.number().int().min(1).max(65_535).default(9464),
  })
  .parse(process.env)

const http: Http = async (path, request = {}) => {
  const response = await fetch(`${environment.PROBE_BASE_URL}${path}`, {
    method: request.method ?? 'GET',
    headers: {
      'user-agent': 'horizon-probe',
      ...(request.bearer ? { authorization: `Bearer ${request.bearer}` } : {}),
      ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(request.idempotencyKey ? { 'idempotency-key': request.idempotencyKey } : {}),
    },
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    signal: AbortSignal.timeout(environment.PROBE_TIMEOUT_SECONDS * 1000),
  })
  const text = await response.text()
  try {
    return { status: response.status, body: text ? JSON.parse(text) : null }
  } catch {
    return { status: response.status, body: text }
  }
}

const log = (line: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...line })}\n`)

let metrics: ProbeMetricsState = EMPTY_METRICS

async function once() {
  const run = await runProbe(
    { http, now: Date.now, newId: randomUUID },
    {
      email: environment.PROBE_EMAIL,
      password: environment.PROBE_PASSWORD,
      ...(environment.PROBE_TENANT_ID ? { tenantId: environment.PROBE_TENANT_ID } : {}),
    },
  )
  metrics = recordRun(metrics, run, Date.now())
  log({
    event: run.ok ? 'probe.succeeded' : 'probe.failed',
    ...(run.failure ?? {}),
    seconds: Object.fromEntries(run.steps.map((step) => [step.step, step.seconds])),
  })
}

const server = createServer((request, response) => {
  if (request.url === '/metrics') {
    response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' })
    response.end(renderMetrics(metrics))
    return
  }
  if (request.url === '/health') {
    response.writeHead(200).end('ok')
    return
  }
  response.writeHead(404).end()
})
server.listen(environment.PROBE_METRICS_PORT)

let timer: ReturnType<typeof setTimeout>
const schedule = (delay: number) => {
  timer = setTimeout(() => {
    void once()
      .catch((error: unknown) => log({ event: 'probe.error', message: String(error) }))
      .finally(() => schedule(environment.PROBE_INTERVAL_SECONDS * 1000))
  }, delay)
}
schedule(0)
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    clearTimeout(timer)
    server.close(() => process.exit(0))
  })
