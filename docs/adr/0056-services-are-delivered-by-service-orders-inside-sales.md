# 56. Services are delivered by service orders inside Sales, and billed once per period

- Status: accepted; Phase 49 implements the service lines and the goods-only sales order,
  Phase 50 the service order, its deliveries and their receivable and NFS-e, Phase 51
  recurring contracts
- Date: 2026-09-26

## Context

Phase K (phases 49–53) lets Horizon sell services: delivered once through a service
order, or repeatedly under a contract billed every period. What already exists:
- **Catalog** has items of kind `product` or `service`. The kind is immutable and
  published in `catalog.item.created`.
- **Fiscal** holds a service fiscal profile per Catalog service, and issues the national
  NFS-e from a service origin keyed by an idempotent source key with a competence month
  (Phase 47).
- **Sales** prices quotes and orders from the Catalog and price lists. A confirmed order:
  - reserves every line in Inventory;
  - is fulfilled by shipments;
  - makes Financial raise the receivable on dispatch.

  `sales.order.confirmed` v1 requires the reservation id.

A service has no stock, no warehouse and no shipment. Today an accepted quote with a
service converts into an order that Inventory rejects for lack of stock, with no reason a
person can act on.

## Decision

1. **A sales order is a goods order.**
   - Placing an order with a service item is refused, and so is converting an accepted
     proposal with service lines. The refusal comes before anything is published, so a
     service never reaches Inventory.
   - An item whose kind is unknown (projected before Phase 49, until the backfill runs)
     keeps being treated as a good.
2. **A proposal carries both.** A Sales quote is the customer's proposal and may price
   goods and services side by side. From Phase 50, converting an accepted proposal creates:
   - a sales order for its goods;
   - a service order for its services, which is delivered stage by stage.
3. **Phase K lives inside `sales/`.**
   - Proposals, service orders and contracts share customers, price lists, sellers and
     payment terms.
   - The reserved module name `services` is not used. If an aggregate later needs its own
     transactional boundary, the split gets its own ADR.
4. **One owner per effect.**
   - Sales owns proposals, service orders, contracts and billed periods.
   - Financial owns the receivable.
   - Fiscal owns the NFS-e.
   - Inventory is never asked about a service.
   - Each effect follows a Sales event (a delivered service, a billed contract period),
     never a call into another module (ADR 0048).
5. **A billed service has one identity.**
   - A delivery or a contract period is identified by its document and the `YYYY-MM` of
     its competence.
   - The same identity is the Fiscal source key and the Financial origin document, so a
     replayed event, a re-run batch or a restarted run maps to the same title and NFS-e.
   - A billed period is immutable; a correction is a linked credit (ADR 0042).
6. **NFS-e issuance follows a policy per establishment.** Fiscal creates an NFS-e draft
   from a billed-service fact and issues it according to the policy:
   - `review`: a person issues it from the worklist;
   - `automatic`: it is issued when ready.

   A municipality the registry does not support leaves a visible refused draft.

## Consequences

- Inventory, Financial and the order events are untouched in Phase 49. No contract change
  is needed: quote events carry no lines, and the order events keep their meaning.
- Sales projects the item kind:
  - replays never change a recorded kind;
  - a one-off, idempotent command fills the kind of items projected earlier.
- An accepted proposal with services stays accepted until service orders exist, and the
  screen says why instead of offering a conversion that would fail.
- Service orders, contracts and billing add Sales tables and events in later phases,
  inside the same database, RLS and outbox.
- **Phase 50 refinement of decision 5.** The national DPS carries one service code, so a
  delivery is billed once in Financial (keyed by the delivery) and once per line in Fiscal
  (source key `sales` / `service-delivery` / the line's `entryId` / competence month). A
  contract period (Phase 52) follows the same rule.
- Fiscal consumes delivered services asynchronously: the broker handler records an intake
  per line, and the worker creates the origin and the draft. It issues the draft when the
  establishment's policy is `automatic`. Whatever stops an intake (a missing profile, an
  unsupported municipality, an incomplete recipient) is shown as a blocked intake with
  its reason, and retried.

## Alternatives rejected

- **Service lines inside the sales order.** This needs one of two things: a
  reservation-less `sales.order.confirmed` version, which changes Inventory and Financial
  handling, or a fake reservation. Either way it duplicates the delivery that the service
  order models with stages.
- **A separate `services/` module now.** It would duplicate the customer projection,
  price lists, proposals and payment terms, plus the full module wiring, before any
  aggregate needs its own boundary.
- **Phase 51: contracts.** Periods are calendar months, quarters or years from the first of
  a month, named by their first month (the competence). A contract changes only by
  insert-only revisions, suspensions and a cancellation that take effect at a period that
  has not begun, so a billed period's revision and amount never change.
