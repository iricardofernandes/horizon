# Phase 79 — Messaging: dead letters of their own, and webhooks that deliver

Status: **delivered on 2026-09-30** ([evidence](hardening-phase79-evidence.md)). The first of
the [debts and hardening](hardening-plan.md) phases.

## Result

After this phase:
- **Each consumer's DLQ holds only the events that consumer refused.**
- **`webhooks`:**
  - it records every workspace's events, provisioned or not, so none is dead-lettered for
    being new;
  - it names the producing module;
  - it answers `400` to an invalid body;
  - it exports the same inbox metrics as every other consumer.
- **A consumer never dead-letters an event only because it is new to it:** Sales and
  Inventory record the workspace with the event, as `webhooks` does and as the other
  modules already did.
- **A binding left by an older version** no longer dead-letters every event of its type:
  the consumer drops the event, removes the binding, logs and counts it.
- **Handler failures are logged** in every consumer (the type and the error class).
- **Reporting settles every source for every workspace:** the seven journal producers
  know each workspace from its creation, and seal it even when it has no events from
  them.

## Starting point (checked on 2026-09-29)

- **Every DLQ holds a copy of every dead letter.** 15 consumers declare their queue with
  `x-dead-letter-exchange: horizon.events.dlx` and bind `<queue>.dlq` to it with `#`
  (Fiscal with its event types). Around 9,000 messages sat in almost every DLQ.
  - `scripts/dead-letters.mjs` sorted them by the queue each died in:
    - 8,858 died in `webhooks.events`;
    - 88 in `financial.events`, 15 in `sales.events`, 3 in `ledger.events`, 2 in
      `fiscal.events` and 1 in `procurement.events`;
    - everything else was copies.
- **`webhooks`:**
  - `recordEvent` inserts into an inbox whose `tenant_id` references `tenants`, and
    nothing ever called `provisionTenant`. The tests always did, so they passed;
  - its `source_module` was the literal `'sales'`;
  - `subscriptionInput.parse` let a `ZodError` become `500`;
  - it counted no inbox metric.
- **Seals:** `sealAllTenants` walked the outbox, so a workspace without rows in a module
  was never sealed by it. The producers' `tenants` rows appear only when the workspace
  acts there; only Catalog listened to `identity.tenant.created`.

## Decisions

1. **Dead letters are routed by where they died, not re-declared.**
   - RabbitMQ refuses to change a live queue's declared arguments, so adding
     `x-dead-letter-routing-key` would have meant deleting every queue in every
     deployment.
   - Instead, every dead letter already carries `x-first-death-queue`. Each consumer:
     - declares a `headers` exchange, `horizon.dead-letters`, bound to
       `horizon.events.dlx` with `#`;
     - removes the old `#` binding (Fiscal also removes its per-type ones);
     - binds `<queue>.dlq` to `horizon.dead-letters` with
       `x-match: all-with-x, x-first-death-queue: <queue>`.
   - `all-with-x` is required: plain `all` ignores headers starting with `x-`, and the
     first probe routed to both DLQs because of it. It needs RabbitMQ 3.10 or later;
     compose and every test use RabbitMQ 4.
   - Nothing is deleted, and no queue argument changes. The routing takes effect when each
     consumer starts.
   - **This revises the plan's migration script**, which is no longer needed.
2. **The old copies:** `scripts/dead-letters.mjs` reports each DLQ by `x-first-death-queue`.
   With `--purge-copies`, it acknowledges only the messages that died elsewhere, and
   requeues the queue's own.
3. **`webhooks`:**
   - the workspace is inserted in the same transaction as its first subscription or
     event;
   - the source is the event type's first word;
   - invalid bodies are `400`, and invalid path ids `404`;
   - `inbox_consumed_total{event_type}` and
     `inbox_dead_lettered_total{reason}` are exported.
4. **Seals:**
   - `sealAllTenants` seals the union of the module's `tenants` and its outbox tenants,
     with a count of 0 for a workspace without rows. Reporting then finds 0 = 0 and
     matches;
   - a migration per module lets the relay role read `tenants.id`;
   - each of the seven producers handles `identity.tenant.created` by recording the
     workspace. Outbox rows are never removed by retention (`NEVER_REMOVED`), so the
     counts stay comparable.

5. **Found while emptying the DLQs** (each with its test, failing on the old code):
   - **Financial dead-lettered every `sales.invoicing.requested`.** Its queue kept the
     binding from the version that read it (ADR 0048 moved the invoice to the dispatch).
     With no handler the consumer threw, and the error was not logged. Now an event
     without a handler removes the queue's binding for its type (on `horizon.events`: the
     routing key is always the type, even for one replayed straight into the queue), is
     acknowledged, logged and counted in `inbox_unbound_total{event_type}`.
   - **Sales dead-lettered `catalog.item.created` of a new workspace** when it arrived
     before `identity.tenant.created`, and every event of a workspace that had never acted
     in Sales. Inventory had the same gap. Both now record the workspace in the inbox
     transaction. Catalog already did.
   - **Seven consumers swallowed handler errors.** They now log the type and error class,
     as CRM and Files did.
   - **`webhooks` could not take back an event claimed before this phase.** The claim was
     under `sales`; redelivered, it passes the inbox under its real module and hit
     `webhook_events`' key. The event's row is now the final word (`on conflict do
     nothing`).
   - **The demo left two DLQs behind** (`horizon.demo.inventory.dlq`,
     `horizon.demo.sales.dlq`) with the old catch-all binding. It now removes them.
6. **What was already there:** `scripts/dead-letters.mjs --replay <queue>` puts a queue's
   own dead letters back into it, taking only as many as were there when it started, and
   each is removed from the DLQ only once the broker confirms the copy. Every consumer
   claims events in its inbox, so an event already applied is not applied twice.

## Proof

- **e2e:**
  - `webhooks`: an event of a workspace it never saw, recorded under its producing module;
    a subscription before any event; a refused event in the refusing queue's DLQ only.
    The three fail on the old code;
  - the seven producers: a workspace with no outbox rows is sealed with 0;
  - Sales: an item of a workspace never provisioned is projected; a type it no longer reads
    is dropped and its binding removed, with nothing in the DLQ;
  - Inventory: an order of a workspace never provisioned is taken;
  - `webhooks`: an event claimed under the wrong module is taken back without failing.
- **`scripts/phase79-smoke.mjs`** on the stack:
  - no catch-all binding is left, and each DLQ is bound to its own queue;
  - a new workspace's webhook is scheduled, with no dead letter;
  - an invalid body is `400`;
  - three sources the workspace never used are sealed;
  - no DLQ grew during the run.
