# `agent/`

The tenant's own MCP server: an AI agent of the workspace reads Horizon through an API
key, with exactly what the person who issued the key may read, and nothing that key's
token could not read by itself.

An independently deployable NestJS service with its own database and container, reached
through Kong at `/agent`, sharing no source with any other module (ADR 0001).

It also runs the **in-app assistant** (Phase 76): a signed-in person's questions answered
from the same read catalogue, with that person's own token, every statement citing what it
read.

**Status: Phase 76.** See the [Phase 72](../docs/ai-phase72-implementation-plan.md),
[Phase 73](../docs/ai-phase73-implementation-plan.md) and
[Phase 76](../docs/ai-phase76-implementation-plan.md) plans,
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
- **The assistant** (Phase 76, ADR 0069), under `/agent/assistant`:
  - **`POST questions`:**
    - the tools are the catalogue's reads of the modules where the person holds a role,
      plus `search_documents`, run through Kong with the person's own token; there are no
      drafts;
    - the model ends with an `answer` tool whose statements cite source ids, and a
      statement with no source it read is returned `found: false`;
    - once document text has been read, the tools close and the model may only answer;
    - at most four model calls.
  - **`GET status`** and **`PUT settings`:**
    - off by default;
    - only an Identity owner turns it on, by accepting the current notice;
    - an owner or admin turns it off or sets the monthly token budget;
    - the switch and the budget are read before every model call.
  - **`GET conversations[/{id}]`, `DELETE conversations/{id}`:**
    - each turn is sealed under the person's own key;
    - kept 30 days after the last turn, then purged hourly across tenants;
    - erased with the person on `identity.data-subject.erased`.
  - **Generators:**
    - `extractive`: deterministic, the stack's default and CI's;
    - `anthropic`: the Messages API; the model is `ASSISTANT_MODEL`, default
      `claude-opus-5-5`. Without `ANTHROPIC_API_KEY` it is unavailable, and nothing is sent.

## What it explicitly does not own

- **Any credential of its own.** Each request exchanges the caller's key through Kong
  (`POST /auth/api-key/token`) and reads through Kong with the 60-second token that comes
  back. The agent has no service token, and its database role has no grant on any business
  table: there is no privileged path (ADR 0065).
- **Business data.** MCP answers pass through and are never stored. The audit keeps a
  SHA-256 of the arguments, the result size and the outcome — never the arguments or the
  answer. The assistant keeps a person's own conversations, sealed, for 30 days; its audit
  entry names the tools, the sources and the tokens, never the question or the answer.
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
npm test          # units: catalogue, caps, digest, the call use case, the assistant, generators
npm run test:e2e  # PostgreSQL and a fake gateway: checks, scopes, audit, RLS, the assistant
node ../scripts/phase72-smoke.mjs   # the real stack, through Kong
node ../scripts/phase76-smoke.mjs   # the assistant through Kong (--no-provider: without a key)
```

Metrics:
- `agent_tool_calls{tool,outcome}` and `agent_exchange_seconds`;
- `assistant_questions{outcome}`, `assistant_tokens{kind}` and `assistant_answer_seconds`.

None has a tenant label.
