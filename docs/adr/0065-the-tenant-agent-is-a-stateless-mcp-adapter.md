# 65. The tenant's agent server is a stateless MCP adapter with no privileged path

- Status: accepted; implemented in Phase 72 ([plan](../ai-phase72-implementation-plan.md),
  [evidence](../ai-phase72-evidence.md)).
  Revises the `tooling/mcp-agent/` entry of the roadmap.
- Date: 2026-09-29

## Context

The roadmap declared a customer-facing MCP server. It left one requirement: **there is no
privileged path**. If an agent can read something, a human holding the same key could have
read it, and the audit log says so. ADR 0035 already built the opposite case, a read-only
debugger with no access to business data.

## Decision

- **A new service, `agent/`,** on port 3015 behind `/agent/mcp`, with the database
  `horizon_agent`. It is a service, not `tooling/`, because it keeps a tenant-scoped audit;
  `tooling/` holds no tenant data.
- **Transport:** MCP streamable HTTP, stateless. The API key comes as
  `Authorization: Bearer`.
- **Every call goes through the key's own token.** The agent exchanges the key (ADR 0064)
  and calls the owning module through Kong with that token.
  - It holds no database role on a business table.
  - It holds no service token or credential of its own.
- **Its tools come from a declared catalogue.** Each entry names:
  - one route and the scope it needs;
  - an input schema;
  - a cap on rows and bytes.

  There is no generic "call any route" tool.
- **Every call is audited,** in a hash-chained, tenant-scoped log with forced RLS:
  - key, issuer, tool, a digest of the arguments, result size, outcome and trace;
  - never the arguments or the results themselves.
- **Access is off by default.** A workspace turns it on, and a key needs `agent:connect`.

## Consequences

- Nothing the agent can do exceeds what the key's token can do. The modules' own guards,
  RLS and audit apply unchanged.
- A tool that cannot work through the caller's token is not built.
- Two hops per call (exchange, then module) cost latency. The exchange is cheap after the
  verified-key cache, and Phase 78 measures it.

## Alternatives considered

**Put the MCP endpoint in each module.** Rejected: fourteen protocol adapters, and no
single place to see what an agent did.

**A service account for the agent.** Rejected: it is the privileged path the roadmap
forbids. The audit would name the service, not the person.

**`tooling/mcp-agent/` as the roadmap said.** Rejected: it needs tenant-scoped storage for
its audit, which makes it a module.
