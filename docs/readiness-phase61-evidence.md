# Phase 61 — evidence: Phase M decisions and the reporting journal

Status: **delivered on 2026-09-27** (local runs between 19:30 and 20:00 UTC).
Plan: [readiness-phase61-implementation-plan.md](readiness-phase61-implementation-plan.md).
Decisions: [ADR 0058](adr/0058-reporting-keeps-a-sealed-event-journal.md) to
[ADR 0063](adr/0063-recovery-is-measured-by-drills.md).

## What was delivered

- **Decisions:**
  - 0058: the reporting journal, seals and watermarks;
  - 0059: bulk data jobs in the owning module;
  - 0060: the `files` module;
  - 0061: access hardening in Identity;
  - 0062: the duties matrix and delegation;
  - 0063: recovery drills and retention.

  They are indexed, and the README counts 63 records.
- **Contracts 0.46.0:**
  - the `reporting` module, with the roles `admin`, `analyst` and `viewer`;
  - `journalSealSchema` and `REPORTING_REPLAY_QUEUE`, registered and compatibility-checked
    as additive.

  Every service is pinned to 0.46.0, and Identity's guard test acknowledges `reporting`.
- **`reporting/`** on port 3013 behind `/reporting`, with database `horizon_reporting`:
  - `event_journal`, append-only by trigger, with RLS forced;
  - `source_seals`, append-only: every seal, matched, mismatched or refused;
  - `source_watermarks`, which a trigger keeps from moving back;
  - the live queue `reporting.events`, bound to the event types of Sales, Financial,
    Treasury, Inventory, Procurement, Ledger, Catalog, CRM and Fiscal;
  - the replay queue `reporting.replay`, with prefetch 1;
  - `GET /sources?cutoff=`, for the roles `admin`, `analyst` and `viewer`;
  - health routes and consumer metrics.
- **`republish:journal`** in Sales, Financial, Treasury, Inventory, Procurement and Ledger,
  each with an e2e test against its own outbox.
- **Platform wiring:**
  - `scripts/modules.json`, the Makefile and `scripts/ci-local.mjs`;
  - compose, Kong and the database init;
  - the web proxy allowlist;
  - the CI workflows: golden path, isolation and release;
  - `scripts/demo.mjs`: the operator holds `reporting:admin`.
- **Documentation:**
  - the glossary: event journal, seal and watermark, settled cutoff;
  - the README row, `reporting/README.md`, and the events catalogue (generated).

## Exit criteria

| Criterion | Evidence |
|---|---|
| `make check` and the local CI pass | see Verification |
| Duplicate and out-of-order delivery leave the journal unchanged | reporting e2e: a later event first, then the earlier one, then both again live and as a replay: two rows, each kept as it first arrived |
| Republishing a range twice changes nothing | producer e2e (the same rows, in order, then the seal); smoke: 347 Sales and 11 Financial events sent twice, with the journal count unchanged after the second run |
| A tenant's journal is invisible to another | reporting e2e: another tenant's application role reads no journal, seal or watermark row; smoke: a token for another tenant sees every source empty |
| A service left on the old contracts pin is caught | `check-contract-pins` passes only with every consumer on 0.46.0, and ran in `make check` |

## Smoke (`node scripts/phase61-smoke.mjs`)

| Step | Result |
|---|---|
| A catalog item created through Kong | journaled live (catalog events 0 → 1; the second run 1 → 2) |
| `republish:journal` in the Sales container | 347 events sent, seal count 347, journal count 347: **matched**; watermark at the seal's `through` |
| The same in Financial | 11 sent, 11 counted: **matched** |
| Both resent a second time | matched again, journal still 347 and 11 |
| Cutoff one minute before the watermarks | Sales and Financial settled; not settled for every source, since Fiscal, CRM and the others were never sealed |
| Cutoff now | Sales not settled |
| `update event_journal`, `delete from source_seals` as the superuser | refused: append-only |
| Another tenant, `reporting:admin` | every source empty, no watermark |
| A token with `sales:admin` only | `403` |

The smoke passed twice in a row.

Treasury, Inventory, Procurement and Ledger were then resent by hand for the same tenant.
All six latest seals matched: Sales 347, Inventory 68, Procurement 37, Financial 11,
Treasury 0 and Ledger 0. None of the 37 procurement rows holds `supplierName`.

## Findings along the way

- **Every dead letter is copied into every dead-letter queue.**
  - `reporting.events.dlq` and `reporting.replay.dlq` each held two `catalog.item.created`
    messages that the journal had in fact recorded.
  - They were dead-lettered by the webhooks consumer, which refuses events of a tenant it
    has not provisioned (the open item found in Phase 57).
  - Every `.dlq` is bound to `horizon.events.dlx` with `#`, so a dead letter from one
    queue lands in all of them. Every older DLQ in the local stack holds the same 1421
    messages.
  - A DLQ's depth therefore says nothing about its own consumer. This is pre-existing and
    left for the retention and service-level phases (69–70), where the DLQ alerts are
    defined.
- **Instants at the millisecond.** Outbox rows keep microseconds and envelopes carry
  milliseconds, so the producer counts at the millisecond too (plan, "Revisions").
- **Fiscal on the old contracts.** The local Fiscal container was rebuilt with
  `make up-fiscal` before any token carried `reporting:*`. Otherwise it would refuse those
  tokens, as it did with `crm:*` in Phase 60.

## Verification

- **`reporting/`:**
  - 14 unit tests, with 100% line coverage of `domain/` and `application/`. One test checks
    every journaled contract for a field that may name a person;
  - 6 e2e tests against PostgreSQL and RabbitMQ.
- **Producers:** 3 e2e tests each in Sales, Financial, Treasury, Inventory, Procurement and
  Ledger.
- **Contracts:** 121 tests; the compatibility check reports one additive schema.
- **`make check`:** passed.
- **Local CI (`make ci-local`):** passed at every step ("Local code and integration gates passed"), after this file existed: repository, pins, contract compatibility, generated files, build and tests of every project, and e2e of every service.
