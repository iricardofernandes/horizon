# 33. OpenTelemetry with a Collector fan-out

- Status: accepted
- Date: 2026-09-07

## Context

A request in Horizon crosses Kong, a service, PostgreSQL, RabbitMQ, a second service,
and possibly a third. When it is slow or wrong, the question "where did the time go" or
"what happened to this order" cannot be answered from any one service's logs.

The naive instrumentation wires each service to a tracing backend directly. That
hard-codes the backend into every service, means a backend outage backpressures the
application, and makes changing a backend a code change in five modules.

## Decision

**OpenTelemetry** SDK in every module and in the Next.js app: traces, metrics and logs,
with auto-instrumentation for HTTP, PostgreSQL, Redis and AMQP.

**An OTel Collector is the single ingestion point.** Nothing talks to a backend
directly. The Collector fans out: **traces → Jaeger**, **metrics → Prometheus**,
**logs → Loki**.

**Log collection via Grafana Alloy.** Promtail is deprecated and is not used.

**Grafana is the single UI**, with datasources and dashboards provisioned as code in
`infra/observability/grafana/provisioning/`.

**Trace context propagates through RabbitMQ headers**, so an asynchronous flow is one
trace end to end. This is what makes the golden path (Phase 8) a single trace across
three services and a broker rather than three disconnected traces.

**Structured JSON logs**, with `traceId` and `spanId` on every line, and `tenantId`
present but **hashed** — so logs are correlatable per tenant without the log store
becoming a tenant-identifier index.

**RED metrics** (rate, errors, duration) per service and endpoint, plus business metrics
where they matter: orders confirmed, outbox lag, webhook delivery failures.

## Consequences

- Backends are swappable in one configuration file. A service knows only the Collector's
  endpoint.
- The Collector absorbs backend outages and buffers, so a Jaeger restart does not
  backpressure the application.
- One agent to configure batching, sampling, retry and redaction, rather than five.
- The Collector is a single point of failure for telemetry. It is not on the request
  path, so its failure loses visibility, not traffic — and the SDK's export queue
  bounds what is lost.
- `traceId` on every log line is what makes the MCP debugger's `search_logs` and
  `get_trace` compose into an actual investigation (ADR 0035).
- Auto-instrumentation carries overhead and produces spans nobody reads. Sampling is
  configured at the Collector, with errors always sampled.
- Hashing `tenantId` means correlating a log to a tenant requires hashing the tenant id
  first. Accepted, and the same hash is used by the MCP debugger so the two agree.
- Every module carries the OTel dependency set. Five copies, per ADR 0001.

## Alternatives considered

**Direct export to each backend.** Rejected as described in Context.

**A single vendor agent (Datadog, New Relic, Grafana Cloud).** Less to run. Rejected: it
requires an account and a paid plan for a portfolio project, and it hides the pipeline
that is worth showing.

**Elasticsearch/OpenSearch for logs.** More powerful querying. Rejected on resource
cost: Loki indexes only labels, which keeps the local stack runnable on a laptop.

**Promtail for log collection.** Rejected: deprecated in favour of Alloy.
