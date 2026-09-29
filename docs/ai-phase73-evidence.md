# Phase 73 evidence — Agent drafts, confirmed by a person

[Plan](ai-phase73-implementation-plan.md) ·
[Phase N plan](ai-implementation-plan.md#73--agent-drafts-confirmed-by-a-person) ·
[smoke record](drills/2026-09-29-phase73-agent-drafts-smoke.json) ·
[ADR 0066](adr/0066-agent-writes-are-drafts.md)

## What was delivered

- **Seven modules count a key's act as its issuer's:** Sales, CRM, Financial, Procurement,
  Inventory, Ledger and Treasury.
  - Their verifiers read `key_issuer`.
  - `actorOf` answers the issuer for a key token.
  - `viaOf` answers `api-key:<id>`, which the command context carries and every audit
    helper writes into the entry's details.
  - Performer fields hold a person, and the duties check of Phase 68 applies unchanged.
- **Agent:**
  - six draft tools, with `DRAFT_ROUTES` as the exact allowlist and `DENIED_ROUTE` as the
    guard;
  - `Gateway.write`, whose idempotency key and derived line ids come from the key, the tool,
    the JSON-RPC request id and the canonical arguments;
  - the created record in the call's audit details;
  - `GET /agent/drafts`, for anyone with a role in the module.

  Draft tools are listed only with `<module>:write`, and are annotated as writing but not
  destructive.
- **Web:**
  - the quotes, requisitions and payables screens and the CRM agenda mark agent drafts with a
    badge linking to Developers → Agent, and offer an "Agent drafts (n)" filter when there
    are some;
  - a failure to read the agent's log marks nothing and never breaks the list.

## Exit evidence

| Criterion | Proof |
|---|---|
| An agent drafts a requisition; its issuer is refused approval with `segregation-of-duties`; another approver succeeds | Smoke in the demo workspace: `draft_purchase_requisition` through a key; `requestedBy` is the operator; the operator submits and gets 403 `segregation-of-duties`; the owner, given `procurement:approver`, approves. The Procurement e2e proves the same at the use cases |
| Retrying the same MCP request creates one draft | Smoke: the same JSON-RPC id answers the same requisition id. Unit test: the same request id gives the same idempotency key and body, and another gives another. The agent e2e does it against a gateway that answers once per key |
| Every write tool is a creation route, and nothing reaches a decision, a posting or access | `catalogue.spec.ts`: the draft tools' paths are exactly `DRAFT_ROUTES`, no tool path matches `DENIED_ROUTE`, and the pattern is shown to catch approve, submit, post, settle, reverse, cancel, convert, confirm, transmission, api-keys, roles, settings and policies |
| A module's audit names the person and the key | Smoke: `requisition.opened` has the operator as actor and `details.via = api-key:<id>`. Procurement e2e: the same, from a context with `via` |

### Also proven

- **A read-only key is offered no draft tool,** and naming one gets `isError`, audited as
  refused.
- **The agent log lists the draft** for the requisitions screen.
- **A task is assigned to the key's issuer** unless another assignee is named (unit test).
- **Tests:**
  - `key-actor.spec.ts` in each of the seven modules;
  - agent: 37 units and 13 e2e (95% coverage of domain and application);
  - web: `agent-drafts.spec.ts`;
  - Procurement: 24 e2e.
- **In the browser,** the requisitions board shows the filter and the badge on the drafted
  card.

## Found along the way

- **Phase 71 had opened segregation of duties to any write key.** A key token's actor was
  `api-key:<id>`, never equal to its issuer, so an issuer could approve what their own key
  had created: an adjustment, a manual entry or a transfer. Mapping the actor in all seven
  modules closes it for integrations as well as agents.
- **The other seven modules still record `api-key:<id>` as the actor** (Catalog, Parties,
  Webhooks, Identity, Fiscal, Reporting, Files). None of them records a performer that a
  duty compares. Their audit already names the key, which is what an auditor needs there.
