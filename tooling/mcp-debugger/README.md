# `tooling/mcp-debugger/`

A read-only MCP server exposing the Horizon observability plane to an AI agent.

**Status: phase 1 — scaffold.** Deliberately the last thing built (phase 12): the tools
have nothing to read until logs, traces and metrics flow.

---

## Why this shape

The common design for "AI in production" gives an agent broad access, lets it watch the
system, and lets it act. It fails twice. The agent needs privileges wide enough that its
compromise is a system compromise. And its reasoning lives inside the runtime, so the
system's behaviour depends on a model being available and correct.

**This inverts that.** The agent gets exactly the read-only handles a competent SRE
would have, and the reasoning lives in the agent, outside the runtime. Nothing about
Horizon's correctness depends on a model being available or right — the ERP runs fully
with this server disabled and with no API key present anywhere.

That argument, not the tool list, is what distinguishes this from a wrapper around a
logging API.

---

## What this project owns

- **Ten read-only tools** over Loki, Jaeger, Prometheus, the RabbitMQ management API and
  PostgreSQL's catalogs.
- **Redaction.** Tenant identifiers hashed and PII masked before any payload leaves the
  process.
- **Its own audit trail.** Every invocation logged with caller identity, tool name,
  arguments and result size.
- **Its own limits.** Per-tool rate limits and result-size caps, so an agent cannot
  drain the log store.

## What it explicitly does not own

- **Any ability to change anything.** No writes, no mutations, no restarts, no replays,
  no queue purges. Debugging is observation.
- **Business data.** Its database role has no privileges on business tables.
- **Unmasking.** There is no tool that reverses redaction. A compromised agent cannot
  ask for the plaintext because the capability does not exist in the API.
- **Being a dependency.** No module imports it, and nothing degrades when it is off.

---

## Tools

| Tool | Source | Purpose |
|---|---|---|
| `search_logs` | Loki | Query by module, level, time range, trace id, free text |
| `get_trace` | Jaeger | Full span tree for a trace id, with timings and error tags |
| `find_slow_traces` | Jaeger | Traces above a latency percentile for a service or operation |
| `get_recent_errors` | Loki | Error entries grouped by exception type and frequency |
| `describe_schema` | `pg_catalog` | Tables, columns, indexes, constraints and RLS policies for one module |
| `explain_query` | PostgreSQL | `EXPLAIN (ANALYZE false)` only, for a single validated `SELECT` |
| `get_slow_queries` | `pg_stat_statements` | Top statements by total and mean time, normalized |
| `list_dlq_messages` | RabbitMQ management API | Dead-lettered messages per queue, with headers and death counts |
| `get_outbox_backlog` | PostgreSQL | Undispatched outbox rows per module, oldest age |
| `get_service_health` | Prometheus | Error rate, latency and saturation per service over a window |

## Database access, precisely

The naive reading of "no access to business tables" makes two of these tools
impossible, so the mechanism is specified rather than improvised (ADR 0035):

- **`describe_schema` reads `pg_catalog`, not `information_schema`.** The
  `information_schema` views filter to objects the querying role has privileges on, so a
  role with no table grants would see an empty database. `pg_class`, `pg_attribute`,
  `pg_indexes` and `pg_policies` are world-readable and return the real answer.
- **`explain_query` runs through a `SECURITY DEFINER` function.** `EXPLAIN` against a
  table the role cannot `SELECT` fails outright. The function is owned by a role with
  `SELECT`-only on business tables, has a fixed `search_path`, parses the statement and
  rejects anything but a single `SELECT` **before it reaches the driver**, and returns
  plan text and nothing else. The debug role keeps no direct table privileges.
- **`get_slow_queries` needs `pg_read_all_stats`.** Without it, `pg_stat_statements`
  shows only the debug role's own statements, which are none. That membership grants
  statistics access, not data access.

`SECURITY DEFINER` is a privilege-escalation primitive and is treated as one: the
parser is tested against multi-statement input, CTEs containing `INSERT`/`UPDATE`/
`DELETE`, and `SELECT` calling a volatile function.

---

## Running it

```bash
npm install
cp .env.example .env

npm run typecheck
npm run lint
npm test
npm run dev
```

For local Claude Code, register the stdio transport; for a remote operator, set
`MCP_TRANSPORT=http` and provide `MCP_BEARER_TOKEN` — the server refuses to start on the
HTTP transport without one, and binds to localhost unless told otherwise.
