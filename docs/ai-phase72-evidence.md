# Phase 72 evidence — The tenant's MCP server, read only

[Plan](ai-phase72-implementation-plan.md) ·
[Phase N plan](ai-implementation-plan.md#72--the-tenants-mcp-server-read-only) ·
[smoke record](drills/2026-09-29-phase72-agent-smoke.json) ·
[module README](../agent/README.md)

## What was delivered

- **`agent/`,** port 3015, database `horizon_agent`, behind Kong at `/agent`. The full wiring
  checklist:
  - `modules.json`, `Makefile`, compose (with its migration job), `kong.yml`;
  - the Postgres init;
  - the isolation, release and golden-path workflows, `ci-local`, `demo.mjs`;
  - the restore drill and its verifier;
  - the web proxy allowlist and the federated audit sources.
- **The endpoint,** `POST /tenants/{tenantId}/mcp`:
  - it uses the SDK's low-level `Server` with a stateless streamable HTTP transport and
    JSON answers;
  - `GET` and `DELETE` answer 405.
- **The catalogue:** 35 read tools over Parties, Catalog, Sales, Inventory, Procurement,
  Financial, Treasury, CRM, Fiscal documents and Reporting. Each input schema is a closed
  object mirroring the route's own query. Path parameters are UUIDs, or the closed list of
  report names, and are encoded.
- **The call use case** (`AgentCalls`):
  1. access on;
  2. the exchange through Kong;
  3. the token verified against Identity's keys, same tenant, `agent:connect`;
  4. then, per call:
     - arguments validated;
     - a `GET` through Kong with the key's token;
     - rows cut to 50 and bytes to 64 KiB;
     - the call audited before the answer leaves (no audit, no data).
- **The audit** has the same shape as every module's `audit_log`, hash-chained per tenant,
  with forced RLS, and is append-only by trigger:
  - action `agent.tool.called`, actor `api-key:<id>`;
  - details: issuer, SHA-256 of the canonical arguments, outcome, status, bytes, rows and
    truncation.

  Switching access writes `agent.access.enabled`/`disabled` in the same transaction.
- **Settings:** `GET` and `PUT /settings`, for an Identity owner or admin with a person's
  token. A key token is refused by the scope check (ADR 0064).
- **Metrics:** `agent_tool_calls{tool,outcome}` and `agent_exchange_seconds`.
- **Web:** Developers → Agent (pt-BR and en), with the endpoint and a copy button, the
  switch, and the call log with the chain verdict. It was checked at 1,280 and 390 pixels.

## Exit evidence

| Criterion | Proof |
|---|---|
| An agent lists its tools and reads records through a key | Smoke: `initialize`, then `tools/list` → `get_party`, `list_parties`; `list_parties` with a search finds the party created for the run; `get_party` reads it by id |
| A key without a module's scope does not see its tools, and a direct call is refused | Smoke and e2e: only the two Parties tools are listed; `tools/call list_sales_orders` answers `isError` and never reaches the gateway (the e2e's fake gateway counts reads); the attempt is audited as `refused` with status 403 |
| A key on another tenant's URL gets 401 and no data | Smoke: the key of workspace A on workspace B's URL answers 401, without the marker. The e2e does the same against the fake gateway |
| Every call is audited without arguments or results; the chain verifies | Smoke: 3 calls under the key's actor, `chain.status: intact`, and the searched name absent from the whole audit page. The e2e also refuses an `UPDATE` on `audit_log` |
| With access off the endpoint refuses, with no exchange | e2e: 403 `agent-access-off` with the exchange count unchanged. Smoke: refused before the switch, and at once after switching off |

### Also proven

- **A key token cannot read the switch or the log** (403 on both).
- **Another workspace's log shows none of these calls.**
- **A revoked key is refused on its next request.**
- **A call that cannot be audited returns no data** (unit test).
- **An argument the tool does not declare is refused and audited** (unit test).
- **Tests:** 32 units (97% coverage of domain and application) and 11 e2e in `agent/`; web
  `agent.spec.ts` and the audit sources test.

## Measured

Ten MCP requests through Kong in the smoke, each an exchange plus a read:
- median 14 ms;
- max 25 ms.

The verified-key cache that ADR 0022 describes is not needed for this latency. ADR 0064's
note stands: whoever adds the cache must invalidate it on revocation.

## Found along the way

- **The SDK's high-level `McpServer` answers a call to an unregistered tool by itself,**
  before any handler. That would have left an attempt at a tool out of reach unaudited. The
  low-level `Server` routes every `tools/call` through the use case.
- **Kong's 30-a-minute limit on `/auth` is per IP, and the web server refreshes every
  browser's session from one IP.** Running the smokes and a browser together exhausts it;
  the screen then shows its error state until the minute turns. It is not new in this
  phase: Phase 71 gave the key exchange its own route for the same reason. It is left for
  the service-level work of Phase 78.
