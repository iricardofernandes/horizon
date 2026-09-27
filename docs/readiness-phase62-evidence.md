# Phase 62 — evidence: cross-domain reports reconciled at a cutoff

Status: **delivered on 2026-09-27** (local runs between 20:05 and 20:45 UTC).
Plan: [readiness-phase62-implementation-plan.md](readiness-phase62-implementation-plan.md).
Decision: [ADR 0058](adr/0058-reporting-keeps-a-sealed-event-journal.md).
API: [reporting-api.md](reporting-api.md).

## What was delivered

- **Four reports, each a query over the journal at a cutoff:**

  | Report | Sources |
  |---|---|
  | cash position | financial, treasury |
  | order to cash | sales, financial, treasury |
  | procure to pay | procurement, financial |
  | pipeline to revenue | crm, sales |

  - Each answers its cutoff, whether its sources are sealed through it, each source's
    watermark, its checks and derived figures, and the latest run at that cutoff.
  - The dashboard reads all four at one cutoff.
- **Reconciliation:**
  - `POST /reporting/reports/{name}/reconciliations` compares each figure with its owner's
    own report, read through Kong with the caller's token;
  - owners that answer their current state are compared only when nothing of theirs
    happened after the cutoff;
  - runs are stored with every check and difference, are append-only, and are audited.
- **Owner summaries:** `GET /sales/orders/summary` and `GET /procurement/orders/summary`.
- **Saved filters:** private, or shared by an administrator, audited in reporting's own
  hash chain.
- **Scheduled seals:**
  - a seal worker next to the relay of Sales, Financial, Treasury, Inventory, Procurement,
    Ledger and CRM;
  - CRM gains `republish:journal`.

## Exit criteria

| Criterion | Evidence |
|---|---|
| `make check` and the local CI pass | see Verification |
| The local stack's history reconciles to zero difference in every check | smoke, twice: the six checks of the four reports `matched` at the settled cutoff |
| A late event after a settled cutoff never changes it | smoke: an opportunity won after the cutoff shows at now (won this month 9 → 10) and leaves the report at the cutoff identical; e2e: a settlement after a sealed cutoff leaves that cutoff's figures unchanged |
| A journal row cannot be changed, and a gap shows as a seal mismatch | Phase 61 e2e and smoke; reconciliation runs and the audit log are append-only too (e2e) |

## Smoke (`node scripts/phase62-smoke.mjs`)

| Step | Result |
|---|---|
| Resend and seal, in 7 producer containers | sales 347, financial 11, treasury 0, inventory 68, procurement 37, ledger 0, crm 80: every seal matched |
| The four reports at the earliest `through` | all `settled: true`; read in 4–6 ms each, dashboard 13 ms |
| Reconciliation, as an analyst holding viewer roles in the owners | cash position: receivables, payables and account balances **matched**; order to cash: confirmed orders (31, 61190 BRL) **matched**; procure to pay: committed orders (11, 110000 BRL) **matched**; pipeline to revenue: won by month **matched** against the CRM forecast at the same cutoff |
| An opportunity won afterwards | the report at now counts it; at the settled cutoff the report is identical |
| A run at now | `409`: not settled |
| A viewer asks for a run | `403` |
| An analyst shares a filter | `400`; an administrator's shared filter is seen by a viewer, the analyst's private one is not; a report read through the analyst's filter shows only BRL |

The second run started less than two minutes after the first one's win, so its cutoff
came before that win and it counted the same 9. Every check matched again.

**A second tenant with real money** (`01a0b6b8…`, the golden-path workspace). The smoke ran
with `--tenant` after its history was resent. It runs CRM's `backfill:owners` when a
workspace has no owners yet.
- **Resent:** sales 316, financial 82, treasury 179, inventory 116, procurement 120,
  ledger 118, crm 0; every seal matched.
- **Every check matched:**
  - the balances of three treasury accounts (123400, 78172 and 120978 BRL) against
    Treasury;
  - 46 confirmed orders (150900 BRL) against Sales;
  - 24 committed purchase orders (432000 BRL) against Procurement;
  - open receivables and payables (none) against Financial;
  - wins against CRM.
- **Derived figures:** 106750 BRL shipped, and 144650 BRL of receivables raised from sales
  and all settled.
- **Late fact:** an opportunity won afterwards showed at now (0 → 1) and nothing at the
  settled cutoff.

## Scheduled seals

- **The first automatic cycle (20:25 UTC)** sealed every tenant with outbox rows in all
  seven producers, with no command run. The first tenant, already resent, matched
  everywhere (CRM 84 of 84).
- **The golden-path tenant's history had never been resent,** so its seals came out
  `mismatched`, with the journal holding 0 against 316 (sales), 82, 179, 116, 120 and 118.
  That is the gap a seal exists to reveal, and no cutoff settled for it.
- **After the resend,** that tenant's seals matched and its reports settled.

## Tests

- **`reporting/` units, 44 tests, coverage 98.8% of lines in `domain/` and
  `application/`:**
  - the report catalogue;
  - figure comparison (big integers included);
  - run outcomes;
  - filters and cutoffs;
  - reading a report and the dashboard;
  - reconciliation: matched, different, forbidden, unavailable, moved before and while an
    owner is read, the as-of owner, an unsettled cutoff;
  - owner and report figures;
  - saved filters and their permissions;
  - roles.
- **`reporting/` e2e, 12 tests against PostgreSQL and RabbitMQ.** Besides Phase 61's:
  - **cash position:** out-of-order settlement facts, a reversed settlement and a reversed
    title, account balances;
  - **order to cash and procure to pay:** latest decisions, cancellations, flows narrowed
    by month while positions are not;
  - **pipeline to revenue:** reopened and converted opportunities, quotes with and without
    attribution;
  - a settled cutoff unchanged by a later fact;
  - a stored run with a verified audit hash;
  - append-only runs and audit;
  - saved filters across users and tenants.
- **Owners:** e2e of both summaries.
- **Producers:** the replay e2e of Sales, Financial, Treasury, Inventory, Procurement,
  Ledger and CRM now also seals every tenant, each with its own count (4 tests each).

## Findings along the way

- **The first tenant holds little financial history.**
  - Its receivables and treasury accounts are empty.
  - The second tenant supplies real balances and receivables, and the e2e suite covers
    the non-empty cases of each figure.
- **A workspace that predates CRM has no owners** until `backfill:owners` runs
  (Phase 55). The smoke runs it when needed.
- **An analyst reconciles only what they can read.** The smoke's analyst holds viewer
  roles in Financial, Treasury, Sales, Procurement and CRM. Without one, that check is
  `forbidden`, never silently skipped.

## Verification

- `make check`: passed.
- Local CI (`make ci-local`): passed at every step ("Local code and integration gates passed"): repository, pins, contract compatibility, generated files, build and tests of every project, and e2e of every service.
