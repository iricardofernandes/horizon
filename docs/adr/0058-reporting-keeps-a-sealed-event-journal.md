# 58. Reporting keeps a sealed event journal, and a cutoff settles on seals

- Status: accepted; Phase 61 implements the journal, seals and watermarks. Phase 62 adds
  projections, reconciliation and scheduled seals.
- Date: 2026-09-27

## Context

ADR 0047 decided that cross-module reports live in a `reporting/` context. That context
consumes events, never writes back, is rebuildable, and states the cutoff of every figure.
It left three questions open for when the context was built:

1. **Rebuilding.** What does a rebuild replay? The broker keeps nothing once a message is
   acknowledged. Replaying through `horizon.events` would redeliver old facts to every
   consumer, including ones whose inbox might have forgotten them.
2. **History from before `reporting/` existed.** Where does it come from? Every producer
   keeps its outbox rows after dispatch, so the history exists, but in each producer's
   own database, which `reporting/` may not read (ADR 0016).
3. **Settling a cutoff.** When can a figure "as of T" be trusted not to change? An event
   that arrived proves only itself. Delivery is asynchronous, a relay can lag, and a
   message can be dead-lettered. A cutoff settled on the wall clock alone (CRM, Phase 59)
   is safe inside one module, where the facts are local. It is not safe across modules.

The events also carry some personal data: party names and contacts, a user's name, a
supplier's name. A reporting store that copies them silently escapes crypto-shredding
(ADR 0026).

## Decision

### The journal

1. `reporting/` keeps an **append-only event journal**: one row per event id, with the
   tenant, source module, type, version, occurred-at instant, trace id, payload, how it
   arrived (`live` or `replay`) and when. Updates, deletes and truncation are refused by
   trigger. RLS is forced like every table.
2. **Projections are functions of the journal.** A rebuild replays the journal, never the
   broker.
3. **What is journaled:**
   - every event of the modules reports are built from: Sales, Financial, Treasury,
     Inventory, Procurement, Ledger, Catalog, CRM and Fiscal;
   - never `parties.*` or `identity.*`. Reports hold party and user ids, and names are
     read from their owners at display time, so erasure there needs nothing here;
   - a field that may carry personal data is removed before the row is written, by a
     redaction declared per event type (today `supplierName` in procurement events). A
     test proves no stored payload carries a declared field.

### History and replay

4. **A producer resends its history to `reporting/` alone.**
   - Its `republish:journal` command reads its own outbox as the relay role and sends each
     row, unchanged and with its event id, to the `reporting.replay` queue through the
     default exchange.
   - No other consumer sees it, so replay is safe whatever their inbox retention is.
   - The journal keeps the first copy of an event id, so a resend changes nothing.

### Seals and settlement

5. **A seal proves completeness.**
   - After a resend, or on its own schedule, a producer sends a seal:
     `{ source, tenantId, through, count }`. `count` is the number of the tenant's outbox
     rows that occurred at or before `through`. `through` is at least two minutes old, so
     no open transaction can still add a row before it.
   - `reporting/` counts its own journal rows for the same tenant, source and bound.
     - If the counts are equal, the source's **watermark** for the tenant moves to
       `through`.
     - If they differ, the watermark stays, and the mismatch is recorded with both counts.
   - Live events never advance a watermark.
6. **A cutoff is settled** for a report when the watermark of every source the report
   reads is at or after it. `GET /sources` also says whether it is settled for all of
   them. Every report answers its cutoff, `settled`, and each source's watermark. A figure
   at an unsettled cutoff is shown as provisional.

### Reconciliation

7. **Reports reconcile or say why not.**
   - Every cross-domain report has a reconciliation check against the owning module's own
     report at the same settled cutoff.
   - The check runs in CI and on a schedule, and its results are stored and shown next to
     the report.
   - A difference is a defect.

### Presentation state

8. **Presentation state held by `reporting/`:**
   - saved filters and views;
   - notifications and their read state;
   - scheduled exports.

   This is state a person owns about their own screens, not a business fact. ADR 0047's
   rule is unchanged: nothing is written to an operational database.

## Consequences

- A rebuild needs no producer to be up, and cannot disturb any other consumer.
- A producer's outbox becomes its durable event history.
  - Deleting outbox rows would now lose reporting history, so outbox retention is decided
    by ADR 0063, not by each module.
  - A producer that loses outbox rows in a restore shows up as a seal mismatch.
- Settlement costs a producer one count query per tenant per seal. It is indexed by
  tenant and instant.
- A source that is sealed rarely keeps cutoffs unsettled. That is visible and correct:
  until it is sealed, nobody knows the figure is final.
- A report cannot show a name that was erased, because it never stored one.

## Alternatives considered

- **Watermarks from the latest live event per source.** Cheap, and wrong: the relay
  publishes in order, but a dead-lettered or redelivered message breaks the inference
  silently.
- **`reporting/` reading each producer's outbox or a "dispatched-through" endpoint.**
  Either couples reporting to producer schemas or adds an authenticated internal API to
  every producer. A seal is one message the producer already knows how to send.
- **Replay through `horizon.events` with the original ids.** Correct only while every
  consumer's inbox remembers every id forever, a property nobody enforces.
- **Journaling personal data encrypted per subject.** Possible, but a report does not need
  a name, and the least data is the easiest to erase.
