# Agent API reference

The tenant's own MCP server and the in-app assistant
([ADR 0065](adr/0065-the-tenant-agent-is-a-stateless-mcp-adapter.md),
[ADR 0066](adr/0066-agent-writes-are-drafts.md),
[ADR 0069](adr/0069-models-are-ports-and-generation-is-opt-in.md); Phases 72, 73 and 76).
- **Path:** through Kong, every path below is prefixed with `/agent`.
- **Credentials:**
  - the MCP endpoint takes an **API key** as the bearer, and exchanges it for a 60-second
    token at every request;
  - every other route takes a **person's** token. A key's token is refused there, because
    it names no `agent:*` scope.
- **Roles:** `agent` has none. Identity's `owner`, `admin` and `auditor` govern its switch
  and log, and every module still decides what its own tools read.

## The MCP endpoint

| Route | Needs | Does |
|---|---|---|
| `POST /tenants/{tenantId}/mcp` | an API key with `agent:connect`, the workspace's agent access on | MCP over streamable HTTP, stateless, JSON answers: `initialize`, `tools/list`, `tools/call` |

A request is admitted in this order:
1. agent access on for the workspace, or `403 agent-access-off`, before any exchange;
2. the key exchanged through Kong (`POST /auth/api-key/token`). The exchange's own refusals
   pass on with their status: `401` for an unknown or revoked key or another workspace,
   `403` for a key now beyond its issuer's roles, `429` with `Retry-After` past 120
   exchanges a minute;
3. the token verified against Identity's keys, for the same tenant, with `agent:connect`.

**Tools** (`agent/src/application/catalogue.ts`):
- the **reads**: 35 `GET` routes of Parties, Catalog, Sales, Inventory, Procurement,
  Financial, Treasury, CRM, Fiscal documents and Reporting. Each needs `<module>:read` or
  `:write`;
- **`search_documents`:** `GET /knowledge/search`, needing `knowledge:read`. It answers
  10 results unless asked for up to 20;
- **six drafts:** `draft_quote`, `draft_purchase_requisition`, `draft_payable`,
  `create_crm_task`, `record_crm_activity` and `write_crm_note`. Each needs
  `<module>:write`, and is idempotent per JSON-RPC request id.

Answers are capped at `AGENT_MAX_ROWS` rows and `AGENT_MAX_RESULT_BYTES` bytes, saying
`truncated: true`. Every call is audited before its answer leaves; a call that cannot be
audited returns no data.

## The workspace's switch and log

| Route | Needs | Does |
|---|---|---|
| `GET /settings` | Identity owner or admin | `{ enabled, updatedBy, updatedAt }` |
| `PUT /settings` | Identity owner or admin | `{ enabled }`: agent access on or off, audited |
| `GET /audit?actor=&action=&subjectType=&subjectId=&from=&to=&cursor=&limit=` | Identity owner, admin or auditor | a page of the hash-chained log (`agent.tool.called`, `agent.access.*`, `assistant.*`), with the chain's verdict |
| `GET /drafts?module=&type=&limit=` | any role in the module | the ids of records the tenant's agents drafted there, with the key, time and sequence |

## The assistant

| Route | Needs | Does |
|---|---|---|
| `GET /assistant/status` | a person | `{ enabled, available, provider, model, notice: { version, accepted, acceptedBy, acceptedAt }, budget: { month, monthlyTokens, spentTokens, questions } }` |
| `PUT /assistant/settings` | turning on: Identity owner, with `acceptNotice: "assistant-notice-v1"`; otherwise owner or admin | `{ enabled?, acceptNotice?, monthlyBudgetTokens? }` (1,000 to 50,000,000); answers the status |
| `POST /assistant/questions` | a person | `{ question, conversationId? }` → `201` with the answer, as below |
| `GET /assistant/conversations` | a person | their conversations of the last 30 days, titled by the first question |
| `GET /assistant/conversations/{id}` | the person it belongs to | its turns, opened |
| `DELETE /assistant/conversations/{id}` | the person it belongs to | `204` |

**An answer:**
- `conversationId` and `turn`;
- `outcome`: `answered`, `stopped-budget` or `stopped-off`;
- `statements`: `[{ text, sources, found }]`, where `found: false` means not found in what
  the person can read;
- `sources`: `S1`, `S2`…, each either:
  - a document: `attachmentId`, `record`, `screen`, `position`, `excerpt`;
  - a record: `tool`, `module`, `screen`, `rows`;

  each with `cited`;
- `toolsCalled`, `toolsRefused` and `usage`.

**Refusals:**
- `403 assistant-off`;
- `409 assistant-unavailable`: no provider key, and nothing was sent;
- `429 assistant-budget-spent`;
- `404 conversation-not-found`.

The tools are the catalogue's reads of the person's modules, and `search_documents`,
called with the person's own token. Once document text has been read, the model may only
answer.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `GATEWAY_URL` | — | Kong, for every exchange and read |
| `AGENT_MAX_ROWS`, `AGENT_MAX_RESULT_BYTES` | 50, 65,536 | the MCP answer caps |
| `ASSISTANT_GENERATOR` | `extractive` | `extractive` (deterministic, in the stack) or `anthropic` |
| `ASSISTANT_MODEL` | `claude-opus-5-5` | the Anthropic model |
| `ANTHROPIC_API_KEY` | none | without it, `anthropic` is unavailable and nothing is sent |
| `ASSISTANT_MASTER_KEY` | — | wraps each person's conversation key (32 bytes) |
| `RABBITMQ_URL` | none | the erasure inbox (`identity.data-subject.erased`) |

## Metrics

None has a tenant label:
- `agent_tool_calls_total{tool,outcome}`;
- `agent_tool_call_seconds{outcome}`;
- `agent_exchange_seconds`;
- `assistant_questions_total{outcome}`;
- `assistant_tokens_total{kind}`;
- `assistant_answer_seconds`.

The service levels are in [service-levels.md](service-levels.md#phase-n--the-agent-the-index-search-and-suggestions).
