# Phase 56 — Pipelines and opportunities

Status: **delivered on 2026-09-27** ([evidence](crm-phase56-evidence.md)). This is the execution record for
[Phase 56 of the CRM plan](crm-implementation-plan.md#56--pipelines-and-opportunities).
Decisions: [ADR 0057](adr/0057-crm-accounts-are-parties-with-typed-documents.md).

## Result

After this phase:
- a workspace configures **pipelines**:
  - each pipeline has ordered stages with a win probability in basis points;
  - stages can be renamed, reordered, re-weighted and archived, but never deleted;
  - a pipeline can itself be archived;
- **sources** and **loss reasons** are tenant lists, archived rather than deleted. An
  account gains a source, as Phase 55 deferred;
- an **opportunity** belongs to an account and has:
  - optional contacts of that account;
  - an owner and an optional source;
  - a title;
  - an expected value (`Money`) and an expected close date;
  - a pipeline and a stage.

  It is revised, moved between stages, reassigned, won, lost with a reason, or reopened;
- every change appends an **opportunity event** to an append-only history. The same fact
  is published as `crm.opportunity.*`:
  - `created`, `revised`, `stage-changed`, `owner-changed`;
  - `won`, `lost` and `reopened`;
- **replaying the history rebuilds the opportunity**: the aggregate is built from its
  own events, and the current row is only their latest fold.

## Starting point

- `crm/` has accounts, contacts, owners, the audit chain, an outbox and a relay, and
  publishes nothing (Phase 55).
- Contracts 0.42.0 declare the `crm` module and its roles. There are no `crm.*` events.
- `moneySchema` (integer minor units as a string, plus a currency) and `dateSchema` are
  the wire formats for amounts and business dates (ADR 0010, 0011).

## Decisions frozen by this plan

1. **Stages are open stages; won and lost are outcomes.**
   - A pipeline lists the stages an open opportunity moves through. `won` and `lost` are
     the opportunity's status, not stages.
   - That gives each pipeline exactly one won and one lost terminal state, as the CRM
     plan asks, and they cannot be misconfigured.
   - A won opportunity counts at 100% and a lost one at 0%.
2. **Archiving keeps history.**
   - An archived stage keeps its opportunities; they can leave it, but none can enter it.
   - A pipeline needs at least one active stage.
   - An archived pipeline keeps its opportunities and takes no new ones.
   - Sources and loss reasons are archived the same way, and names are unique among the
     active entries of each list.
3. **The history is the aggregate.**
   - `Opportunity` applies its own events (`created`, `revised`, `stage-changed`,
     `owner-changed`, `won`, `lost`, `reopened`). Commands only decide which event
     happens.
   - `opportunity_events` stores them in order, per opportunity and append-only (trigger),
     with actor and instant.
   - The `opportunities` row is the latest fold, and a test rebuilds it from the history.
4. **What an event carries.** Each event carries the facts Phase 59 metrics need:
   - pipeline, stage and its probability at that moment;
   - owner and source;
   - value, close date and loss reason.

   The title and contacts are never published: a title may name a person, and contacts
   are personal data.
5. **Owners and sources are checked when used.**
   - Creating an opportunity or reassigning it needs a known, active owner.
   - A source or loss reason must be active when chosen, and it stays on the record if
     archived later.
6. **Roles.**
   - Configuring pipelines, sources and loss reasons is a new CRM action, `configure`,
     held by `admin` and `manager`.
   - Moving, revising, winning, losing and reopening need `write`.
   - Reassigning the owner needs `assign`, as for accounts.
7. **`revised` is added to the event list.** The CRM plan listed six events. A forecast
   also needs to know when an expected value, close date or source changed, so `revised`
   carries exactly those fields.
8. **Reopening** returns a lost or won opportunity to an active stage of its pipeline.
   Phase 58 will forbid reopening an opportunity won by an accepted quote.

## Work

### A — Contracts (0.43.0)

`events/crm.ts` with the seven `crm.opportunity.*` events at version 1. They are added to
the registry and the events catalogue, and every module is pinned to 0.43.0.

### B — CRM

1. **Domain:**
   - `Pipeline` (stages, probability, order, archive);
   - `ListEntry` (source, loss reason);
   - `Opportunity`, built from its events and with command methods that emit them;
   - `Money`, `ProbabilityBps` and `CloseDate` value objects.
2. **Application:**
   - pipelines: create, rename, add, change and reorder stages, archive and unarchive;
   - lists: create, rename, archive;
   - opportunities: create (idempotent), revise, move, reassign, win, lose, reopen;
   - account source in `UpdateAccountProfile`.
3. **Migration `0001_opportunities`:**
   - `pipelines`, `pipeline_stages`, `list_entries`, `opportunities` and
     `opportunity_events` (append-only);
   - `accounts.source_id`;
   - forced RLS, grants and checks.
4. **HTTP:**
   - `/pipelines` (with `/stages` and `/stage-order`);
   - `/sources` and `/loss-reasons`;
   - `/opportunities`: list with filters; detail with history; `POST`; `PUT`;
     `POST …/stage`, `…/owner`, `…/win`, `…/lose`, `…/reopen`.

### C — Evidence

1. Unit tests:
   - pipeline rules (probability bounds, archive, order, last active stage);
   - opportunity transitions and refusals;
   - fold equals state;
   - list uniqueness;
   - use cases with the in-memory store.
2. e2e:
   - history append-only and rebuilt from the database;
   - an archived stage keeps its opportunities;
   - lost, reopened and lost again keeps both closures;
   - events in the outbox, without titles;
   - RLS on the new tables;
   - idempotent creation.
3. `scripts/phase56-smoke.mjs` through Kong:
   - a pipeline with stages, a source and a loss reason;
   - an opportunity created, moved, reassigned, lost, reopened, then won;
   - an archived stage refused as a destination;
   - the events relayed to RabbitMQ (a `crm.opportunity.won` read back from a probe
     queue);
   - a representative refused on configuration.
4. `make check`, the CRM e2e, `make ci-local`, and isolated jobs for `crm` and `contracts`.

## Exit evidence

- Archiving a stage leaves the opportunities on it, and their history, intact.
- A lost opportunity keeps its reason. Reopening it keeps both closures in its history.
- Replaying CRM events gives the same opportunity state.

## Revisions made while implementing

- **Idempotency fingerprint.** The fingerprint of `pipeline.create`,
  `source/loss-reason.create` and `opportunity.create` included the command context. That
  context carries the request id, which Kong changes on every request, so a real retry
  through the gateway was refused as "a different request". The smoke found it; it is the
  Phase 50 pitfall again. The context is now excluded, with a regression test.
- **Restoring a list entry.** A restored or renamed entry now checks for a name
  collision before it changes. Before, the entry restored in memory could count as the
  holder of its own name.

## Out of scope

- Activities, tasks and notes (Phase 57).
- Conversion to a quote and attribution (Phase 58).
- Forecast and metrics (Phase 59).
- Screens (Phase 60).
