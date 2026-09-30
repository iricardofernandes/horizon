# Phase 79 evidence — Messaging: dead letters of their own, and webhooks that deliver

[Plan](hardening-phase79-implementation-plan.md) · [debts and hardening](hardening-plan.md) ·
[smoke](drills/2026-09-30-phase79-messaging-smoke.json)

## The dead-letter queues, before and after

| | Before (2026-09-29) | After the routing and `--purge-copies` | After the fixes and `--replay` (2026-09-30) |
|---|---|---|---|
| Messages in almost every DLQ | ~9,000, each a copy of every other queue's | only the queue's own | **0 in every DLQ** |
| `webhooks.events.dlq` | ~9,000 | 8,858 | 0: 8,858 recorded (3 after the last fix below) |
| `financial.events.dlq` | ~9,000 | 88, all `sales.invoicing.requested` | 0: 88 dropped as no longer read, binding removed |
| `sales.events.dlq` | ~9,000 | 15 (`parties.party.updated` ×8, `catalog.item.created` ×7) | 0: 15 applied |
| `ledger.events.dlq` | ~9,000 | 3 (`financial.receivable.posted`, 09-19) | 0: applied; the cause was already fixed |
| `fiscal.events.dlq` | ~9,000 | 2 (fiscal profiles, 09-23) | 0: applied; the cause was already fixed |
| `procurement.events.dlq` | ~9,000 | 1 (`parties.party.updated`, 09-27) | 0: applied; the cause was already fixed |

`scripts/dead-letters.mjs` sorts each DLQ by `x-first-death-queue`. `--purge-copies`
removed only messages that had died elsewhere. `--replay <queue>` then put each queue's own
back once its cause was fixed.

## Proof

- **The smoke** (`node scripts/phase79-smoke.mjs`), 5 of 5 on the rebuilt stack:
  - each of the 16 DLQs is bound only to its own queue's dead letters, and no catch-all
    binding is left (the first run found Fiscal's old per-type bindings, from a container
    `make up-apps` does not rebuild, and two DLQs the demo left; see below);
  - an invalid webhook body is `400`;
  - a new workspace subscribes, and its first event is scheduled, not dead-lettered;
  - Treasury, Ledger and Procurement seal a workspace that never used them;
  - no DLQ grew during the run.
- **e2e tests that fail on the old code:**
  - `webhooks`, 4: an event of a workspace it never saw, under its producing module; a
    subscription before any event; a refused event in the refusing queue's DLQ only; an
    event claimed before this phase under the wrong module, taken back;
  - the seven producers: a workspace with no outbox rows is sealed with 0;
  - Sales, 2: an item of a workspace not yet provisioned is projected; a type it no longer
    reads is dropped and its binding removed, with nothing in the DLQ;
  - Inventory, 1: an order of a workspace not yet provisioned is taken.
- **After `make demo`:** Financial's queue no longer has the `sales.invoicing.requested`
  binding, and no DLQ holds a message.

## Found and fixed in this phase

- **Financial had dead-lettered every `sales.invoicing.requested` since 09-19.** Its queue
  kept the binding from the version that read the event. With no handler, the consumer
  threw and logged nothing. An event without a handler now removes the binding, is
  acknowledged, logged and counted (`inbox_unbound_total`). This is done in the twelve
  consumers with a handler table.
- **Sales refused events of a workspace that had not acted in it**, and a
  `catalog.item.created` that overtook `identity.tenant.created`. Inventory had the same
  gap. Both now record the workspace in the inbox transaction.
- **Seven consumers swallowed handler errors.** Treasury, Ledger, Financial, Inventory,
  Parties, Procurement and Sales now log the event type and the error's class. The payload
  is not logged, since it may carry personal data.
- **This phase's own change to `webhooks` broke the redelivery of older events.** The
  inbox claim now names the real module, so an event claimed as `sales` before passed the
  claim again and hit `webhook_events`' key. Three such events kept dying on replay. The
  event's row now decides (`on conflict do nothing`).
- **`--replay` looped** on an event that died again, since the event came back to the DLQ
  it was reading. It now takes only as many as were there when it started.
- **The demo left `horizon.demo.inventory.dlq` and `horizon.demo.sales.dlq` behind**, with
  the catch-all binding. It now removes them, and the two leftovers (empty) were deleted.
- **Fiscal is not rebuilt by `make up-apps`.** It is the `fiscal` profile (`make up-fiscal`).
  Until it was rebuilt, its DLQ kept the per-type bindings.

## Not done, stated

- **No migration script.** The plan named one to re-declare every queue. Routing on
  `x-first-death-queue` made it unnecessary, since a consumer's start is enough (decision 1
  in the plan).
- **The replay is manual.** An operator runs `--replay` once a cause is fixed. Nothing
  replays by itself, since a dead letter may be dead for a reason still standing.

## Verification (2026-09-30)

- `node scripts/ci-local.mjs --full`: every gate passed (typecheck, lint, unit and e2e of
  every module, clean installs, generated contracts, every Docker image) except the
  whitespace check, for a trailing space in `plan.md`. It was fixed and `git diff --check`
  run again, but the full run was not repeated.
- `make demo` twice, `make test-alerts` and `make test-phase10` (the browser golden path):
  all passed. After them and the smoke, every DLQ holds 0 messages.
