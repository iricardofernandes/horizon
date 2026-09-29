# Phase 72 — The tenant's MCP server, read only

Status: **delivered on 2026-09-29** ([evidence](ai-phase72-evidence.md)). This is the execution record for
[Phase 72 of the AI with isolation plan](ai-implementation-plan.md#72--the-tenants-mcp-server-read-only),
built on ADR 0064 (keys reach modules) and ADR 0065 (a stateless adapter with no privileged
path).

## Result

After this phase, a tenant's own agent:
- connects with an API key to `POST /agent/tenants/{tenantId}/mcp`;
- lists the tools its key's scopes allow;
- reads through them what the key's issuer could read.

It has these guarantees:
- **No privileged path.** Every call is:
  - an exchange of the key (ADR 0064);
  - then a `GET` through Kong with the resulting 60-second token.

  `agent/` holds no service token and no grant on any business table.
- **A declared catalogue.** Thirty-five read tools over Parties, Catalog, Sales, Inventory,
  Procurement, Financial, Treasury, CRM, Fiscal documents and Reporting. Each tool names:
  - one route and the scope it needs;
  - an input schema;
  - a cap on rows.

  There is no generic tool.
- **Every call is audited** in `agent/`'s own hash-chained log:
  - key, issuer, tool, a digest of the arguments, result size, outcome and trace;
  - never the arguments or the result.

  The log has the same shape as every other module's, so the federated audit screen of
  Phase 68 reads it too.
- **Off by default.** A workspace owner or admin turns agent access on. A key also needs
  `agent:connect`. With access off, the endpoint refuses before any exchange.
- **The Developers screen** shows the endpoint, the switch, and the call log with the
  chain's verdict.

## Starting point

- **Phase 71:** keys exchange for scoped tokens, and every module enforces `scp`.
- **`agent` port and name:** 3015 and the name `agent` are reserved in the expansion plan's
  port table. `agent:connect` is in the scope vocabulary.
- **Precedent:** `tooling/mcp-debugger/` uses `@modelcontextprotocol/sdk` 1.30 with a
  streamable HTTP transport per request, for observability only.
- **What the reads look like:**
  - Several reads take strict queries (Parties, Catalog, Fiscal): an unknown parameter is a
    400.
  - Others (Sales lists) take none and return every row.

## Decisions frozen by this plan

1. **`agent/` is a NestJS service like the others.** It has:
   - the database `horizon_agent`, with two tables: `agent_settings` and `audit_log`;
   - no outbox and no inbox.

   It publishes and consumes no events. A call is a read, and nothing else needs to know it
   happened.
2. **The tenant is in the URL:** `/tenants/{tenantId}/mcp`.
   - A key does not carry its tenant, and Identity looks a key up inside the tenant it is
     addressed to.
   - A key sent to another tenant's URL fails its exchange with 401, so the URL cannot
     widen anything.
3. **The order of checks on every MCP request:**
   1. a well-formed tenant id and a `Bearer hz_…` credential, otherwise 401;
   2. agent access on for the tenant, otherwise 403 `agent-access-off`, **before any
      exchange**;
   3. the exchange through Kong: 401, 403, 429 (with `Retry-After`) and 503 pass through
      as they are;
   4. `agent:connect` among the token's scopes, otherwise 403;
   5. only then the MCP message: `initialize`, `tools/list` or `tools/call`.

   Stateless: every POST builds its own server and transport, with JSON responses (no SSE
   stream). `GET` and `DELETE` on the endpoint answer 405.
4. **The catalogue lives in `application/catalogue.ts`.** Each entry names:
   - its module and required scope (`<module>:read`, satisfied by `:write` too, as in
     modules);
   - a path template with UUID path parameters;
   - the query parameters it may pass, with a zod input schema that mirrors the route's
     own;
   - its kind (`list` or `get`).

   Path parameters are validated as UUIDs (or a closed enum for report names) and encoded,
   so no argument can change the route.
5. **Caps:**
   - a list returns at most `AGENT_MAX_ROWS` rows (50); a route that returns every row is
     cut here;
   - any answer longer than `AGENT_MAX_RESULT_BYTES` (64 KiB) is cut.

   A cut answer says so (`truncated: true`), with the rows it kept.
6. **Errors reach the agent as tool errors,** never as internals. The status and the
   module's `detail`/`title` (at most 200 characters) are passed on:
   - 401, 403 and 404 are outcome `refused` (or `not-found`);
   - 5xx and timeouts are `failed`, with a generic message.
7. **Audit:**
   - action `agent.tool.called`, actor `api-key:<id>`, subject `agent-tool`/`<tool>`;
   - details: `{ issuer, argumentsDigest, resultBytes, rows, truncated, outcome, status }`,
     where the digest is SHA-256 of the canonical JSON of the arguments;
   - settings changes are `agent.access.enabled`/`disabled`, by the person.

   `GET /audit` answers the page with its chain verdict, as in every module. Identity
   owner, admin or auditor may read it (`agent` holds no roles, like `files`).
8. **Settings:** `GET /settings` and `PUT /settings` (`{ enabled }`), for the Identity owner
   or admin with a person's token. A key token is refused by the scope check, because no
   `agent:read`/`agent:write` scope exists.
9. **Not in this phase:**
   - writes (Phase 73);
   - document search (Phase 75);
   - a verified-key cache. Phase 71's exchange is measured here, as `agent_exchange_seconds`,
     and the cache is added only if the latency calls for it.

## Work

1. `agent/`: the project, the migration with forced RLS and an append-only audit, the
   runtime, the guard, `health/ready`, and the settings, audit and MCP controllers.
2. The catalogue, the call use case (exchange, `GET`, cap, audit) and its ports, and the
   HTTP adapters that exchange and read through Kong.
3. **Metrics:** `agent_tool_calls_total{tool,outcome}` and `agent_exchange_seconds`.
4. **Wiring:**
   - `modules.json`, `Makefile`, compose, Kong (`/agent`);
   - the Postgres init;
   - the CI lists, `ci-local`, `demo.mjs`, the restore drill and its verifier;
   - the web proxy allowlist and the federated audit list.
5. **Web:** `/app/developers/agent`, with the endpoint URL, the access switch and the call
   log, in pt-BR and en.
6. **Tests:**
   - units: catalogue, caps, digest and the call use case;
   - e2e: with PostgreSQL and a fake gateway, covering the order of checks, filtering by
     scope, audit without arguments, RLS and the chain;
   - `scripts/phase72-smoke.mjs` through Kong, speaking JSON-RPC.

## Exit evidence

- An agent (JSON-RPC over the endpoint, as the MCP Inspector would send it) lists its tools
  and reads records through a key.
- The same key without a module's scope does not see that module's tools, and a direct
  call to one is refused.
- A key used on another tenant's URL gets 401, and no data of that tenant comes back.
- Every call is in the audit, which never holds the arguments or the results. The chain
  verifies.
- With agent access off, the endpoint refuses and no exchange is made.
