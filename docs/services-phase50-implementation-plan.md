# Phase 50 — Service orders and execution

Status: **delivered on 2026-09-26** ([evidence](services-phase50-evidence.md)). This is the execution record for
[Phase 50 of the services plan](services-implementation-plan.md#50--service-orders-and-execution).

## Result

After this phase:
- converting an accepted **proposal** with service lines creates a **service order** for
  them, beside the sales order for its goods, from the same accepted version;
- a service order can also be opened directly. It is `scheduled`, then `in_progress`,
  then `completed` once everything is delivered, then `accepted` by the customer; or it is
  `cancelled` with a reason;
- work is recorded as **deliveries**:
  - each delivery covers some quantity of some lines (partial per line), on the day it
    was performed;
  - each one publishes `sales.service.delivered` once;
- **Financial** raises one receivable per delivery, with the delivery's installments;
- **Fiscal** turns each delivered service line into a service origin and an NFS-e draft
  keyed by a source key. The draft waits for a person (`review`) or is issued at once
  (`automatic`), per establishment;
- **cancelling a delivery** publishes `sales.service.delivery-cancelled`:
  - Financial withdraws or reverses the title;
  - Fiscal cancels the NFS-e (event 101101) inside the municipal window, and shows the
    refusal outside it.

## Starting point

- **Proposals:** a Sales quote may mix goods and services (Phase 49). An accepted one with
  service lines cannot be converted, and the screen says why.
- **Payment terms:** Sales publishes dated installments from them for every shipment
  (`scheduleFrom`).
- **Financial:**
  - raises an effective receivable per shipment, keyed by the origin document, so a
    replay finds the same title;
  - the origin enum is extended additively, as `sales-shipment` was.
- **Fiscal:**
  - creates a service origin through the API from explicit revisions, with an optional
    `sourceKey` that maps a repeated request to one origin (Phase 47);
  - drafts, validates, issues and cancels the NFS-e through its API;
  - nothing consumes a Sales service fact yet.
- The NFS-e national layout carries **one service code per DPS**.

## Decisions

1. **The service order lives in Sales** (ADR 0056), in its own tables, aggregate and
   routes. It never touches Inventory and has no warehouse.
2. **Conversion splits a proposal by kind.** One transaction, one idempotency key:
   - goods lines become a sales order, as today, and need a fulfilment warehouse;
   - service lines become a service order, which needs none.
   - The quote records both documents, and one acceptance never converts twice.
   - Money is split between the two documents:
     - the discount is split in proportion to each side's net, and the goods take the
       remainder cent;
     - freight belongs to the goods.
     - A proposal with freight and no goods is refused.
3. **A delivery is the billed unit.**
   - It carries:
     - the performed date: not in the future, and never before the order was opened;
     - its competence month;
     - per line: quantity, gross value and the amount billed;
     - the installments from the order's payment terms, dated from the performed date.
   - What a delivery bills is the order total's share of everything delivered so far,
     minus what the active deliveries already billed. The deliveries of a completed order
     therefore add up exactly to its total, with no cent lost to rounding.
   - A delivery never changes after it is recorded. Cancelling one keeps it, marks it
     cancelled with a reason, and makes its quantities deliverable again.
4. **Identities** (ADR 0056, decision 5):
   - **Financial:** origin `sales-service-delivery`, keyed by the delivery id.
   - **Fiscal:** one origin per delivery line (the DPS carries one service code), with
     `sourceKey` = `sales` / `service-delivery` / the delivery line's `entryId` /
     competence month.
   - Replaying either event, or the same facts under a new event id, maps to the same
     title and the same origin and NFS-e.
5. **Fiscal intake is asynchronous and visible.**
   - The broker handler only records an intake per delivery line, inside the inbox
     transaction.
   - The Fiscal worker then resolves what the origin needs:
     - the establishment with the active NFS-e capability in the issuer's municipality;
     - the issuer, recipient and service-profile revisions in force at the competence
       date.
   - It then creates the origin and the draft and, under `automatic`, validates and
     issues.
   - A missing profile, an unsupported municipality, an incomplete recipient or a missing
     capability leaves the intake **blocked**, with its reason. The worker retries it
     with backoff, and an operator can ask for an immediate retry.
6. **Issuance policy** per establishment: `review` (the default) or `automatic`, plus the
   DPS series. It is set through the Fiscal API by a rules administrator and audited.
7. **Cancellation of a delivery:**
   - **Financial:**
     - a draft title is cancelled;
     - a posted title with no settlement in force is reversed, because the service was
       not provided;
     - a settled title is left for a person, with an audit entry saying so.
   - **Fiscal:**
     - an authorized NFS-e gets event 101101, reason 2 ("service not provided");
     - outside the municipal window the intake shows the refusal;
     - a draft that was never issued is withdrawn, and issuance refuses it from then on;
     - a transmission in flight is waited for.
8. **Acceptance** by the customer is a record with no money or fiscal effect. It closes
   the order.
9. **Cancelling the order itself** is allowed only while no delivery is active.
   Delivered work is undone delivery by delivery, so every reversal names what it
   reverses.

## Work

### A — Contracts (`@horizon/contracts` 0.38.0, additive)

1. `sales.service.delivered` v1: `serviceOrderId`, `deliveryId`, `customerId`,
   `performedOn`, `competence`, `deliveredBy`, lines (`entryId`, `lineId`, `itemId`,
   `description`, `quantity`, `unitPrice`, `amount`), `value`, `installments`,
   `complete`.
2. `sales.service.delivery-cancelled` v1: `serviceOrderId`, `deliveryId`, `customerId`,
   `competence`, `entryIds`, `cancelledOn`, `reason`.
3. `financial.receivable.posted` origin `sales-service-delivery`.
4. Fiscal HTTP schemas: issuance policy (request and read) and service intake (read).
5. Snapshot, `docs/events.md` and every consumer pinned to 0.38.0.

### B — Sales

1. **Migration `0012_service_orders.sql`:**
   - tables `service_orders`, `service_order_lines`, `service_deliveries` and
     `service_delivery_lines`, with RLS, grants and checks;
   - a trigger that keeps a recorded delivery's facts and lines immutable;
   - `quotes.service_order_id`, with one service order per proposal.
2. **Domain:**
   - `ServiceOrder` aggregate with the stages and deliveries;
   - pure delivery pricing (`service-billing.ts`);
   - two event classes;
   - unit tests.
3. **Use cases:**
   - open a service order directly: service items only, priced from the projection;
   - start, deliver (the rest when no lines are given), accept, cancel;
   - cancel a delivery;
   - conversion split in `ConvertQuoteUseCase`.
4. **HTTP:**
   - `GET/POST /sales/service-orders`, `GET /sales/service-orders/{id}`;
   - `POST /{id}/start`, `/{id}/deliveries`, `/{id}/accept`, `/{id}/cancel`,
     `/{id}/deliveries/{deliveryId}/cancel`;
   - `POST /sales/quotes/{id}/order` takes an optional warehouse and answers `orderId`
     and `serviceOrderId`, either of which may be null.
5. Persistence in its own file, so `sales-database.ts` does not grow; in-memory fake for
   the unit tests.

### C — Financial

1. Origin `sales-service-delivery`: domain enum, contract and migration.
2. `sales.service.delivered` raises an effective receivable, `SV-…`, with the delivery's
   installments, at most once per delivery.
3. `sales.service.delivery-cancelled` cancels, reverses or flags the title, as in
   decision 7.

### D — Fiscal

1. **Migration `0051_phase50_service_intake.sql`:**
   - `fiscal_service_issuance_policies`;
   - `fiscal_service_intakes`, one row per delivery line: status, reason, attempts,
     next attempt, origin and document;
   - RLS.
2. **Ingress:**
   - binds both Sales events;
   - records the intakes, and a withdrawal request on cancellation;
   - a conflicting replay is refused.
3. **Intake worker, in the existing per-tenant cycle:**
   - pending → origin → draft → (automatic) validate → issue;
   - blocked with a reason and backoff;
   - withdrawal: cancel the NFS-e, withdraw the draft, or wait.
4. Issuance refuses a document whose intake was withdrawn.
5. **API:**
   - `GET/PUT /fiscal/service-issuance-policies/{establishmentId}`;
   - `GET /fiscal/service-intakes` (filter by status);
   - `POST /fiscal/service-intakes/{id}/retry`.

### E — Web

1. **Quote dialog:**
   - an accepted proposal with services converts;
   - the warehouse is asked for only when it has goods;
   - the result names the sales order and the service order.
2. The service order screens are Phase 53. Until then the API and the smoke are the
   operator surface.

### F — Evidence and documentation

1. **Unit tests:**
   - service order stages and refusals;
   - delivery pricing: exact totals over partial deliveries and cancellations;
   - conversion split: discount, freight, goods only, services only;
   - Financial use cases;
   - Fiscal intake decisions.
2. **e2e with PostgreSQL:**
   - Sales: conversion, lifecycle, outbox events, immutability and RLS/cross-tenant on the
     new tables;
   - Financial: one title per delivery on replay, cancellation;
   - Fiscal: intake → origin → draft → NFS-e once on replay, blocked intake, withdrawal
     and cancellation, RLS.
3. **Local stack smoke `scripts/phase50-smoke.mjs`:**
   - a mixed proposal converts into a sales order and a service order;
   - start, a partial delivery, then the rest, then acceptance;
   - one receivable per delivery;
   - NFS-e issued under `automatic`;
   - a replay of the delivered fact under a new event id changes nothing;
   - cancelling a delivery cancels the title and the NFS-e.
4. Browser workflow: a mixed proposal converted from the dialog.
5. `make ci-local`; evidence record; ADR 0056 consequences; plan, README and glossary
   updates.

## Exit evidence

| Criterion | Evidence planned |
|---|---|
| Replaying `sales.service.delivered` creates no second title, origin or NFS-e | Financial and Fiscal e2e; smoke replay under a new event id |
| A cancellation reverses both | Financial and Fiscal e2e; smoke: title cancelled and NFS-e cancelled by 101101 |
| Cross-tenant and RLS tests cover the new tables | Sales and Fiscal e2e |
| A proposal becomes both documents once | Sales e2e and smoke |
| Deliveries add up to the order total | Domain tests over partial deliveries and cancellations |

## Out of scope

- Service order screens, the board and customer views (Phase 53).
- Contracts and period billing (Phases 51–52).
- A forecast receivable for an open service order.
- Substitution (105102) driven by Sales. A corrected delivery is a cancellation and a new
  delivery.
- Metrics and alerts for intakes (Phase 52 adds billing metrics).

## Changes made during implementation

- **Idempotent retries through the gateway.** Sales fingerprinted a command together
  with its context, request id included, and Kong gives every request a new id. A retry
  under the same key was therefore refused as a different request. The smoke found it on
  the conversion retry. The fingerprint now covers the command and its body only, with a
  unit test. The same pattern exists in Inventory and is left for its own change.
- **Performed day and time zones.** Sales dates are UTC days, while a person records work
  on their local day. The rule that work cannot predate the order was dropped, since work
  recorded after the fact may predate it. "Not in the future" now allows one day past the
  UTC day, so today is accepted in every time zone. Fiscal still refuses a competence
  after the issuer's local day (E0015). The intake waits for that day with an explicit
  reason instead of failing on the origin.
- **Service order line positions.** Line and delivery-line positions are stored, so a
  delivery of "everything still owed" and its NFS-e keep the order the lines were sold in.
- **A cancellation that overtakes its delivery.** Financial and Fiscal refuse it, which
  rolls back the inbox claim so the broker brings it again. Tests cover both.
- **A withdrawal that lands mid-step.** Code review found that a cancellation arriving
  while the Fiscal worker advanced an intake could have its due time overwritten by that
  step's record. The record now keeps such a withdrawal due at once, with an e2e that
  cancels from inside the draft step.

