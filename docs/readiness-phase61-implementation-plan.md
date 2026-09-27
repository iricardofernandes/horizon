# Phase 61 — Phase M decisions and the reporting journal

Status: **delivered on 2026-09-27** ([evidence](readiness-phase61-evidence.md)). This is the execution record for
[Phase 61 of the production readiness plan](production-readiness-implementation-plan.md#61--phase-m-decisions-and-the-reporting-journal).

## Result

After this phase:
- ADRs 0058–0063 record the Phase M decisions;
- `reporting` is a module name with the roles `admin`, `analyst` and `viewer` (contracts
  0.46.0), and every service is pinned to it;
- `reporting/` runs on port 3013 behind `/reporting` and keeps an append-only journal of
  every event of the modules it reports on;
- the six producers that the first reports need can resend their history to
  `reporting/` alone, and prove how much of it `reporting/` holds;
- `GET /reporting/sources` answers, per source, what the journal holds, how far it is
  proven complete, and whether a cutoff is settled.

There are no reports yet. They start in Phase 62, on this journal.

## Starting point

- **Outboxes:** every producer keeps its outbox rows after dispatch (`dispatched_at`),
  and nothing deletes them. A producer's full history is therefore already in its own
  database, readable by its relay role across tenants.
- **Outbox relay:** it publishes in `created_at` order and stops a batch at the first
  failure.
- **Inboxes:** they deduplicate by `(source_module, event_id)`. `INBOX_RETENTION_DAYS` is
  declared but no module deletes inbox rows.
- **Personal data:** the `parties.*` events carry names, emails, phones and addresses;
  `identity.user.registered` carries a name; `procurement` events carry `supplierName`,
  which may name a person. The CRM, Sales, Financial, Treasury, Inventory, Ledger, Catalog
  and Fiscal events carry ids, amounts, dates and business names only.
- **The CRM module** (Phase 55) is the most recent template for a new service.

## Decisions frozen by this plan

1. **What the journal holds.**
   - **Sources:** every event of `sales`, `financial`, `treasury`, `inventory`,
     `procurement`, `ledger`, `catalog`, `crm` and `fiscal`.
   - **Not journaled:** `parties.*` and `identity.*`. Reports show names by asking
     Parties at display time, so erasure there needs nothing here.
   - **Redaction:** `supplierName` is removed from procurement payloads before they are
     stored (ADR 0058). The redaction is declared per event type, and a test proves no
     journaled payload carries a declared personal field.
   - **Journal rows:** one row per event id, with its tenant, source, type, version,
     `occurred_at`, trace id, payload, how it arrived (`live` or `replay`) and when.
     Updates, deletes and truncation are refused by trigger.
2. **Two queues.**
   - `reporting.events` is bound on `horizon.events` to every event type of the
     journaled sources, and receives the live flow.
   - `reporting.replay` is fed through the default exchange by a producer's republish
     command, one message at a time (prefetch 1), so a seal is read after the events
     sent before it.

   A replay never goes through `horizon.events`, so no other consumer sees an old event
   again.
3. **Seals prove completeness; arrival does not.**
   - **What a producer sends:** a seal `{ source, tenantId, through, count }`, where
     `count` is the number of the tenant's outbox rows with `occurred_at <= through`.
     `through` is at least two minutes in the past, so no open transaction can still add
     a row before it.
   - **What `reporting/` does with it:**
     - it counts its journal rows for the same tenant, source and bound;
     - if the counts are equal, the source's watermark for the tenant becomes `through`;
     - if they differ, the watermark stays, and the mismatch is recorded with both
       counts.
   - A live event never advances a watermark: it proves only that it arrived, not that
     nothing before it is missing.
   - A cutoff is **settled** for a report when every source it reads has a watermark at
     or after it. `GET /sources` answers it per source and for all of them.
   - The seal message shape is published in contracts as `journalSealSchema`, with the
     queue name `REPORTING_REPLAY_QUEUE`.
4. **`republish:journal` in each first producer.** Sales, Financial, Treasury, Inventory,
   Procurement and Ledger each gain:

   ```bash
   npm run republish:journal -- --tenant <uuid> [--since <iso>] [--until <iso>] [--seal-only]
   ```

   - It reads the tenant's outbox as the relay role, in `occurred_at, id` order, in
     batches.
   - It sends every row to `reporting.replay` as the envelope that was published, with
     the same event id.
   - It then sends the seal for `until` (default: now minus two minutes).
   - `--seal-only` sends only the seal.
   - It is idempotent: the journal keeps the first copy of an event id.

   CRM, Fiscal and Catalog gain theirs in the phase whose report first reads them.
   Sealing on a schedule, from each producer's relay, is Phase 62.
5. **The module name, not a second one.**
   - Only `reporting` is declared in contracts now.
   - `files` (ADR 0060) holds no roles of its own: it checks the owning module's roles.
     It needs no module name until it is an API-key scope, so it is not declared.
     This revises the Phase M plan.
6. **No projections, commands or outbox yet.**
   - `reporting/` gets a `command_receipts` table, an audit log and an outbox when it
     first accepts a command (Phase 62, saved filters) or publishes an event.
   - `replay:journal` arrives with the first projections, in Phase 62.

## Work

### A — Decisions and contracts

1. **ADRs:**
   - **0058:** reporting journal, seals, watermarks and reconciliation; extends ADR 0047;
   - **0059:** bulk data jobs owned by the owning module;
   - **0060:** the `files` module;
   - **0061:** access hardening in Identity;
   - **0062:** duties matrix and delegation;
   - **0063:** recovery objectives and drills.

   Each is indexed in `docs/adr/README.md`, with the README count updated.
2. **Contracts 0.46.0:**
   - the `reporting` module and its roles;
   - `journalSealSchema` and `REPORTING_REPLAY_QUEUE`, entered in the registry.
3. **Pins:** every project moves to 0.46.0, and Identity's guard test acknowledges
   `reporting`.

### B — `reporting/`

1. **The project,** from the CRM template: config, Dockerfile, README, migrate script,
   test setup.
2. **Migration `0000_reporting.sql`:**
   - `tenants`, `event_journal` (append-only), `source_seals` and `source_watermarks`;
   - forced RLS on every table;
   - `horizon_app` may insert into the journal and seals, and upsert watermarks, nothing
     else.
3. **The domain:**
   - the journaled sources;
   - the redaction per event type;
   - watermark and settlement rules as pure functions, with unit tests.
4. **The application:**
   - `JournalEvent`, for live and replayed events;
   - `ApplySeal`;
   - `DescribeSources`.
5. **The infrastructure:**
   - the live consumer and the replay consumer;
   - the database;
   - `GET /sources?cutoff=` behind the `reporting` roles;
   - the health check, telemetry and metrics: journaled events, seals matched or
     mismatched.
6. **The e2e suite:**
   - duplicate and out-of-order delivery;
   - a replay after a live event;
   - a seal that matches and one that does not;
   - a settled and an unsettled cutoff;
   - redaction;
   - the append-only trigger;
   - cross-tenant reads;
   - roles.

### C — Producers

In Sales, Financial, Treasury, Inventory, Procurement and Ledger:
- `src/main/republish-journal.ts` and the `republish:journal` script;
- an e2e test: every outbox row of the tenant is sent once, in order, and followed by the
  right seal, and `--seal-only` sends only the seal.

### D — Platform wiring

These places gain `reporting`:
- `scripts/modules.json` (3013) and the Makefile;
- compose, the database init, and Kong (`/reporting`);
- the web proxy allowlist;
- the CI lists: golden path, isolation and release;
- `scripts/ci-local.mjs`;
- `scripts/demo.mjs`, where the operator becomes `reporting:admin` and the database is
  migrated.

### E — Evidence

1. `scripts/phase61-smoke.mjs`, on the local stack:
   - a live sale reaches the journal;
   - `republish:journal` in Sales and Financial resends the history, and the journal
     count does not change for events already held;
   - the seals match, and a cutoff before the seal is settled while one after it is not;
   - a journal update is refused;
   - another tenant sees nothing.
2. Glossary entries: journal, seal, watermark, settled cutoff. The README and the Phase M
   plan are updated.

## Exit evidence

- `make check` and the local CI pass.
- The smoke passes, including a second run.
- Duplicate and out-of-order delivery leave the journal unchanged.
- Republishing a range twice changes nothing.
- A tenant's journal is invisible to another.
- A service left on the old contracts pin is caught by the pin check.

## Revisions made while implementing

- **Instants compare at the millisecond.**
  - An outbox keeps microseconds, but an envelope carries milliseconds.
  - The producer therefore counts `date_trunc('milliseconds', occurred_at)`, so its count
    and the journal's agree on the same bound.
- **A seal is refused inside the margin by `reporting/` as well.** The producer refuses
  such a bound, and `reporting/` records one it receives as `refused`, with its own clock.
- **The watermark table refuses to move back** by trigger, as well as in the use case.
- **The replay logic lives in `infrastructure/messaging/journal-replay.ts`** of each
  producer, so its e2e test runs it against the module's own outbox, with no broker.

## Out of scope

- Projections, reports and `replay:journal` (Phase 62).
- Scheduled seals from each producer's relay (Phase 62).
- The `republish:journal` command in CRM, Fiscal and Catalog, which arrives when a report
  first reads them.
