# 35. The MCP debugger is read-only by construction

- Status: accepted
- Date: 2026-09-07

## Context

The common shape for "AI in production" is an agent with broad access that watches a
system and proposes or takes actions. It fails in two ways. It needs privileges wide
enough that its compromise is a system compromise. And its reasoning lives inside the
runtime, so the system's behaviour depends on a model being available and correct.

The inversion is to give the agent exactly the read-only handles a competent SRE would
have and put the reasoning in the agent, outside the runtime. Nothing about the ERP's
correctness then depends on a model at all.

## Decision

A **standalone MCP server** at `tooling/mcp-debugger/`, opt-in behind
`HORIZON_MCP_DEBUGGER_ENABLED` (default `false`). **Horizon runs fully with it disabled
and with no Anthropic API key present.** It is not a runtime dependency of any module;
it is an operator tool reading the observability plane.

**Transports:** stdio for local Claude Code, and streamable HTTP with bearer auth for a
remote operator, bound to localhost by default.

**Tools — all read-only:** `search_logs` (Loki), `get_trace` (Jaeger),
`find_slow_traces` (Jaeger), `get_recent_errors` (Loki), `describe_schema`,
`explain_query`, `get_slow_queries` (`pg_stat_statements`), `list_dlq_messages`
(RabbitMQ management API), `get_outbox_backlog`, `get_service_health` (Prometheus).

**Safety constraints, non-negotiable:**

- A dedicated PostgreSQL role with no access to business tables and no write privilege.
- No tool writes, mutates, restarts or replays anything. Debugging is observation.
- Tenant identifiers hashed and PII masked before any payload leaves the server. The
  mask list is configuration, and **unmasking is not implementable through the API** —
  there is no tool that reverses it, so a compromised agent cannot ask for the
  plaintext.
- Every invocation logged with caller identity, tool name, arguments and result size.
- Per-tool rate limits and result-size caps, so an agent cannot drain the log store.

**The two database tools need a mechanism the constraints do not obviously permit, and
it is specified here rather than improvised:**

- `describe_schema` reads **`pg_catalog`** (`pg_class`, `pg_attribute`, `pg_indexes`,
  `pg_policies`, `pg_constraint`), which is world-readable, **not `information_schema`**,
  whose views filter to objects the querying role has privileges on — a role with no
  table privileges would see an empty schema.
- `explain_query` cannot run `EXPLAIN` against a table the role cannot `SELECT`. It is
  therefore implemented as a **`SECURITY DEFINER` function** owned by a role holding
  `SELECT`-only on business tables, granted `EXECUTE` to the debug role, which parses the
  statement and **rejects anything but a single `SELECT` before it reaches the driver**,
  then returns `EXPLAIN (ANALYZE false)` plan text and nothing else. The debug role
  itself still holds no direct table privileges, so the only reachable path into
  business tables is a function that returns a query plan.
- `get_slow_queries` requires membership in `pg_read_all_stats` to see statements from
  other roles; without it `pg_stat_statements` shows only the debug role's own queries,
  which are none. That membership is granted, and it grants statistics access, not data
  access.

The blanket "no `EXECUTE`" constraint is therefore refined to: **no `EXECUTE` except the
single, audited, parse-validated `explain` function.**

`tooling/mcp-debugger/README.md` states the design argument above, not just the usage.
That argument is the part that distinguishes this from a wrapper.

## Consequences

- The worst case for a compromised agent or a leaked bearer token is disclosure of
  operational telemetry with tenants hashed and PII masked. It cannot change anything.
- The system is fully operable, testable and demonstrable with the debugger off. It is
  phased last (Phase 12) because it has no value until logs, traces and metrics flow.
- The agent must compose tools to investigate — find a slow trace, fetch it, search logs
  by its trace id, explain the query the slow span names. That composition is the
  reasoning, and it belongs in the agent.
- `SECURITY DEFINER` is a privilege-escalation primitive and is treated as one: the
  function has a fixed `search_path`, takes exactly one text argument, and its parser is
  tested against injection attempts including multi-statement input, CTEs containing
  `INSERT`/`UPDATE`/`DELETE`, and `SELECT` calling a volatile function.
- Result-size caps mean an answer can be truncated. The tool says so explicitly rather
  than silently returning a prefix.

## Alternatives considered

**An agent with write access that can remediate.** Rejected: it makes a model's mistake
an outage, and its compromise a system compromise.

**Embedding the reasoning in the runtime — an LLM analysing errors inside a service.**
Rejected: it makes the ERP's behaviour depend on a model's availability and correctness,
which is precisely the coupling this design avoids.

**Granting the debug role `SELECT` on business tables and relying on RLS.** Simpler, and
it would make `explain_query` trivial. Rejected: RLS scopes by tenant, not by column, so
the role would be able to read personal data for whatever tenant context it set. The
`SECURITY DEFINER` wrapper keeps the capability without the access.

**Skipping `explain_query` and `get_slow_queries` to keep the role privilege-free.**
Rejected: query plans and statement statistics are most of the value of database
observability, and the wrapper makes them available without granting data access.
