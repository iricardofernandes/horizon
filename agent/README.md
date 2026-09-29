# `agent/`

The tenant's own MCP server: an AI agent of the workspace reads Horizon through an API
key, with exactly what the person who issued the key may read, and nothing that key's
token could not read by itself.

An independently deployable NestJS service with its own database and container, reached
through Kong at `/agent`, sharing no source with any other module (ADR 0001).

**Status: Phase 73.** See the [Phase 72](../docs/ai-phase72-implementation-plan.md) and
[Phase 73](../docs/ai-phase73-implementation-plan.md) plans,
[ADR 0064](../docs/adr/0064-api-keys-reach-modules-through-scoped-tokens.md) and
[ADR 0065](../docs/adr/0065-the-tenant-agent-is-a-stateless-mcp-adapter.md).

---

## What this context owns

- **The MCP endpoint,** `POST /agent/tenants/{tenantId}/mcp`: streamable HTTP, stateless,
  JSON answers. The credential is an API key as the Bearer token.
- **The declared catalogue** (`src/application/catalogue.ts`): read tools over Parties,
  Catalog, Sales, Inventory, Procurement, Financial, Treasury, CRM, Fiscal documents and
  Reporting. Each tool is one `GET` route, with the scope it needs, an input schema that
  mirrors the route's own, and a row cap. There is no tool that takes a path.
- **`search_documents`** (Phase 75): the workspace's attachments searched by meaning and by
  words through `GET /knowledge/search`, with `knowledge:read`. Only the modules the key
  reaches are searched, and every result cites its attachment, record and excerpt.
- **Six draft tools** (Phase 73, ADR 0066): `draft_quote`, `draft_purchase_requisition`,
  `draft_payable`, `create_crm_task`, `record_crm_activity`, `write_crm_note`. They need
  `<module>:write`, write only to the six creation routes in `DRAFT_ROUTES`, and are
  idempotent per JSON-RPC request (key and line ids derived from key, tool, request id and
  arguments). The module counts the draft as the key issuer's, so the issuer cannot approve
  it; the agent's log records the created record's id.
- **The drafts list,** `GET /agent/drafts?module=&type=`: the ids of records agents drafted
  in one module, for anyone holding a role in it. The quotes, requisitions, payables and
  agenda screens mark and filter them.
- **The switch,** `GET` and `PUT /agent/settings`: agent access per workspace, off by
  default, changed by an Identity owner or admin.
- **The audit log,** `GET /agent/audit`: every tool call and every switch, hash-chained per
  tenant, with the chain's verdict per page. Identity owners, admins and auditors read it.

## What it explicitly does not own

- **Any credential of its own.** Each request exchanges the caller's key through Kong
  (`POST /auth/api-key/token`) and reads through Kong with the 60-second token that comes
  back. The agent has no service token, and its database role has no grant on any business
  table: there is no privileged path (ADR 0065).
- **Business data.** Answers pass through and are never stored. The audit keeps a SHA-256
  of the arguments, the result size and the outcome — never the arguments or the answer.
- **Any decision.** No tool submits, approves, posts, settles, cancels, reverses, issues or
  converts, or touches access, keys or settings; `DENIED_ROUTE` and its test say so.

## One request, in order

1. A well-formed tenant id and a `Bearer hz_…` key, otherwise **401**.
2. Agent access on for the tenant, otherwise **403** `agent-access-off`, before any
   exchange.
3. The key exchanged through Kong. Its refusals pass through: **401**, **403**, **429** with
   `Retry-After`, and **503**.
4. The token verified against Identity's keys, for the same tenant, holding
   `agent:connect`, otherwise **403** `agent-connect-missing`.
5. The MCP message. `tools/list` shows only the tools of the modules the key has a scope
   for. `tools/call` validates the arguments, reads, cuts the answer to `AGENT_MAX_ROWS`
   rows and `AGENT_MAX_RESULT_BYTES` bytes, and audits the call **before** the answer
   leaves. A call that cannot be audited returns no data.

A call to a tool out of the key's reach, or with arguments the tool does not declare, is
refused and audited like any other.

## Connecting an agent

Create a key under Developers → API keys with `agent:connect` and a read scope for each
module the agent should read. Turn access on under Developers → Agent, then point the MCP
client at the endpoint that screen shows, for example:

```json
{
  "mcpServers": {
    "horizon": {
      "type": "http",
      "url": "http://localhost:8000/agent/tenants/<tenant id>/mcp",
      "headers": { "Authorization": "Bearer hz_live_…" }
    }
  }
}
```

## Running and testing

```bash
npm install
npm test          # units: catalogue, caps, digest, the call use case
npm run test:e2e  # PostgreSQL and a fake gateway: the order of checks, scopes, audit, RLS
node ../scripts/phase72-smoke.mjs   # the real stack, through Kong
```

Metrics: `agent_tool_calls{tool,outcome}` and `agent_exchange_seconds`, with no tenant
label.
