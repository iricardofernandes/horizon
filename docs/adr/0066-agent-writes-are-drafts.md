# 66. An agent's writes are drafts, and a draft by a key is its issuer's

- Status: accepted; planned for Phase 73 ([Phase N plan](../ai-implementation-plan.md)).
- Date: 2026-09-29

## Context

An agent that only reads is safe but limited. An agent that posts, approves or pays turns a
prompt injection into a financial event. Horizon already separates drafting from deciding:
- quotes, requisitions and payables have drafts;
- approval is a separate act, and segregation of duties is a declared matrix (ADR 0062).

## Decision

- The agent's catalogue has write tools **only for draft-shaped records**: a quote, a
  purchase requisition, a CRM task, note or activity, and a payable draft.
- It has **no tool** that:
  - posts, approves, settles, cancels, reverses or issues a fiscal document;
  - changes access, keys or settings.

  A test enumerates the catalogue against a deny list of route shapes.
- Every write carries an `Idempotency-Key` derived from the MCP request id and a digest of
  the arguments.
- **For segregation of duties, a record created by `api-key:<id>` counts as created by its
  issuer.** The issuer cannot approve what their agent drafted.
- Screens mark agent drafts, naming the key and its issuer.

## Consequences

- The worst an injected instruction can do through the agent is create a draft that a
  person must still approve.
- Enforcing the duties matrix needs the key's issuer in the token: the `key_issuer` claim
  of ADR 0064.

## Alternatives considered

**Allow any write the key's scopes allow.** Rejected: scopes are per module, not per act.
`financial:write` would let an agent settle a payable.

**A confirmation step inside the MCP protocol.** Rejected: the confirming "person" would
be the agent's own client, which Horizon cannot trust.
