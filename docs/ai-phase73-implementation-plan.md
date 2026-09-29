# Phase 73 — Agent drafts, confirmed by a person

Status: **delivered on 2026-09-29** ([evidence](ai-phase73-evidence.md)). This is the execution record for
[Phase 73 of the AI with isolation plan](ai-implementation-plan.md#73--agent-drafts-confirmed-by-a-person),
built on ADR 0066 (an agent's writes are drafts, and a draft by a key is its issuer's).

## Result

After this phase:
- **A tenant's agent can draft.** Six write tools create records that a person still has to
  take further:
  - a sales quote;
  - a purchase requisition;
  - a payable draft;
  - a CRM task, activity or note.

  Each needs `<module>:write`, is idempotent, and is audited in the agent's log with the
  record it created.
- **Nothing else is writable.**
  - The catalogue's write tools are an exact allowlist of creation routes.
  - A test refuses any route that approves, submits, posts, settles, cancels, reverses,
    issues, converts, or touches access, keys or settings.
- **A record a key creates counts as created by the key's issuer,** in every module that
  records performers or enforces segregation of duties:
  - Sales, CRM, Financial, Procurement, Inventory, Ledger and Treasury;
  - the issuer cannot approve what their agent drafted, and the refusal is the shared
    `segregation-of-duties`;
  - the key is kept as `via` in the module's own audit entry, so its trail still names it.
- **The four lists** (quotes, requisitions, payables, CRM tasks) mark agent drafts, can be
  filtered to them, and link to the agent's call log.

## Starting point

- **Phase 72:** the agent reads through the key's own token; its catalogue has 35 `GET`
  tools and no write.
- **Phase 71:** a key token names its issuer in `key_issuer`, but modules read only `sub`.
  - A key with `inventory:write` creates an adjustment as `api-key:<id>`, and its issuer
    may approve it.
  - Segregation of duties is therefore open to anyone holding a write key since Phase 71.
    This phase closes it.
- **Uniform shape:** each of the seven modules has one `actorOf` and one audit helper that
  takes a `CommandContext`, so the change is uniform.

## Decisions frozen by this plan

1. **The duty actor of a key token is its issuer.**
   - `actorOf(request)` answers `key_issuer` when the token has one, and `sub` otherwise.
   - The command context also carries `via: api-key:<id>`, which each module's audit
     helper writes into the entry's details.
   - Performer fields (`requestedBy`, `createdBy`, the quote's author, the task's creator)
     therefore hold a person, and the duties check needs no change.
   - The other seven modules keep `sub` as their actor: they record no performer that a
     duty compares, and their audit already names the key.
2. **Drafts are marked from the agent's log, not with a column in four modules.**
   - After a successful write, the agent reads the created id from the module's answer
     (`id`, `quoteId`, `taskId`, `activityId`, `noteId`).
   - It records `record: { module, type, id }` in the call's audit details.
   - `GET /agent/drafts?module=&type=` answers the ids of agent drafts, with key, time and
     sequence, to anyone holding a role in that module.
   - The lists read it once per load. The agent's hash-chained log is the one place that
     says "an agent made this", and a module does not need to know agents exist.
3. **Idempotency:**
   - the key is `agent-` + SHA-256 of the key id, the tool, the JSON-RPC request id and the
     canonical arguments;
   - line ids the route requires are derived from the same digest.

   Retrying the same MCP request sends the same body with the same key, and the module
   answers the first result.
4. **The write tools:** `draft_quote`, `draft_purchase_requisition`, `draft_payable`,
   `create_crm_task`, `record_crm_activity` and `write_crm_note`.
   - Their inputs mirror the routes, minus what the agent derives: line ids, and a task's
     assignee (the issuer, unless one is given).
   - A payable is drafted `effective` and never posted.
5. **The allowlist is the test:** a write tool's `POST` path must be one of the six
   creation routes, and no tool path may match the deny pattern. A new write tool means
   editing both, in review.

## Work

1. **The seven modules:**
   - the verifiers read `key_issuer`;
   - `actorOf` maps a key token to its issuer;
   - the command context carries `via`, and the audit helpers record it;
   - guard specs, and an e2e where a key creates and its issuer is refused approval.
2. **Agent:**
   - catalogue entries with a method and a draft type;
   - `Gateway.write`, and the idempotency key from the request id;
   - the six tools;
   - the record id in audit details;
   - `GET /drafts`;
   - units and e2e.
3. **Web:** a "drafted by agent" badge and filter in quotes, requisitions, payables and CRM
   tasks, linking to Developers → Agent.
4. **`scripts/phase73-smoke.mjs`,** through Kong:
   - an agent drafts a requisition;
   - its issuer submits it and is refused approval;
   - a second person approves;
   - a retried MCP request creates nothing new;
   - a write through a read-only key is refused;
   - the draft shows in `/agent/drafts`.

## Exit evidence

- An agent drafts a requisition; its issuer is refused approval with
  `segregation-of-duties`, and another approver succeeds.
- Retrying the same MCP request creates one draft.
- Every write tool is one of the six creation routes, and no tool reaches a decision,
  posting or access route.
- A module's audit names the person and the key for a record an agent drafted.
