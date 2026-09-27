# Phase 49 — Service lines and service decisions

Status: **delivered on 2026-09-26** ([evidence](services-phase49-evidence.md)). This is the execution record for
[Phase 49 of the services plan](services-implementation-plan.md#49--service-lines-and-service-decisions).

## Result

After this phase:
- a **proposal** (a Sales quote) can price goods and services side by side, and every
  line says which it is;
- a **sales order stays a goods order**. A service item is refused when an order is
  placed, and when an accepted proposal with service lines is converted, with a stable
  reason instead of a stock rejection that explains nothing. Phase 50 converts those lines
  into a service order.
- Sales knows each item's kind from the Catalog events, and a one-off backfill corrects
  the items projected before this phase;
- a **fiscal operator can maintain the service fiscal profile** of each Catalog service
  (national tax code, NBS, ISS treatment, effective date) from a screen, instead of only
  through the API;
- **ADR 0056** records the Phase K decisions (below).

## Starting point

- The Catalog item has an immutable `kind` (`product` or `service`), published in
  `catalog.item.created`. Sales' `catalog_items` projection ignores it.
- The quote screen already lists active service items, and quotes price them from the
  projection. An accepted quote with a service line converts into an order:
  - the order asks Inventory to reserve the service;
  - Inventory rejects the reservation, and the order ends `rejected` with no reason a
    person can act on.
- `sales.order.placed` means "reserve these lines". `sales.order.confirmed` v1 requires a
  `reservationId`, and Inventory uses it to commit the reservation.
- Fiscal already stores service fiscal profiles (Phase 47:
  `POST /fiscal/service-profiles`, `GET /fiscal/service-profiles/{itemId}`), with no
  screen.

## Decisions frozen by this plan (ADR 0056)

1. **A sales order is a goods order; a service is delivered by a service order.**
   Putting service lines inside the sales order would need the following, and would
   duplicate the service order of Phase 50:
   - a `sales.order.confirmed` version without a reservation;
   - new handling in Inventory and Financial;
   - a second, stageless way to deliver a service.

   The proposal is the only document that carries both kinds. From Phase 50, converting
   an accepted proposal creates a sales order for its goods and a service order for its
   services.
2. **Phase K stays inside `sales/`.**
   - Proposals, service orders and contracts share customers, price lists, sellers and
     payment terms.
   - The reserved module name `services` is used only if an aggregate later needs its own
     transactional boundary, recorded in its own ADR.
3. **Ownership.**
   - Sales owns proposals, service orders, contracts and billed periods.
   - Financial owns receivables.
   - Fiscal owns the NFS-e.
   - Inventory is never asked about a service.
   - Each effect follows one owner event (ADR 0048).
4. **Identity of a billed service.**
   - A delivery or a contract period is identified by `(document, YYYY-MM of its
     competence)`.
   - The same identity is the Fiscal `sourceKey` and the Financial origin document, so a
     replay maps to the same title and NFS-e.
   - A billed period is immutable; a correction is a linked credit (ADR 0042).
5. **NFS-e issuance policy.** Fiscal creates an NFS-e draft from a billed-service fact
   and issues it per establishment policy: `review` or `automatic` (Phases 50 and 52).
6. **An unknown kind is a product.**
   - Items projected before this phase have no kind until the backfill runs.
   - Until then they keep today's behaviour, so nothing that works today starts to be
     refused.

## Work

### A — Sales

1. Migration `0011_catalog_item_kind.sql`:
   - `catalog_items.kind`, nullable, checked against `product` and `service`;
   - an index for the backfill.
2. `catalog.item.created` records the kind. A replay never changes a kind already
   recorded, because the Catalog kind is immutable.
3. **Refusals:**
   - placing an order with a service item: `409` "service items are delivered by a
     service order, not a sales order";
   - converting an accepted quote with a service line: `409`, naming the lines.

   Both are domain rules with unit tests. Quote pricing is unchanged.
4. **Reads:** quote and order lines expose `kind` (`product`, `service` or `null` while
   unknown).
5. **Backfill command** `npm run backfill:item-kinds -- --tenant <id>`, with `CATALOG_URL`
   and a Catalog read token in the environment:
   - reads the Catalog items and fills only rows whose kind is unknown;
   - idempotent and audited in the Sales audit log;
   - prints what it changed.

### B — Web

1. **Proposal form:** each item option shows its kind, and each line shows a
   "Serviço"/"Service" tag.
2. **Order form:** lists goods only.
3. **Quote dialog:**
   - shows the kind of each line;
   - when an accepted quote has service lines, "Convert to order" is replaced by a note
     that services convert to a service order in Phase 50. The server still refuses.
4. **New screen `Fiscal → Perfis de serviço` (`/app/fiscal/service-profiles`):**
   - lists Catalog service items with their current fiscal profile (national tax code,
     NBS, effective date, revision) or "sem perfil";
   - the item's revision history;
   - a form for a new revision (administrator only; the API refuses other roles).
5. Messages in pt-BR and en, and unit tests for the new pure helpers.

### C — Evidence and documentation

1. Sales e2e with PostgreSQL:
   - the kind projection and a replay of it;
   - the backfill;
   - both refusals;
   - an unknown kind still ordered as a product;
   - RLS on the column.
2. Local stack:
   - backfill the local tenants;
   - a proposal with a service and a product;
   - a goods order still confirmed and shipped;
   - the conversion refused with its reason;
   - a service profile created from the screen.

   The browser workflow covers the new screen and the proposal tags.
3. `make check` and the local CI pass, and the goods golden path is unchanged.
4. ADR 0056; `services-implementation-plan.md` updated with the revised decision; glossary
   entries (proposal, service order, billed period); the Sales README; evidence record.

## Exit evidence

| Criterion | Evidence planned |
|---|---|
| Decisions recorded before service code | ADR 0056 |
| A service never reaches Inventory | Sales domain tests and e2e: order and conversion refused before any `sales.order.placed` |
| Goods path unchanged | Existing Sales e2e and the browser golden path pass unchanged |
| Kind known for old and new items | e2e for projection and backfill; backfill output on the local stack |
| Service fiscal profile maintainable by a person | Browser workflow creates a revision and reads it back |

## Out of scope

- The service order itself and its conversion from a proposal (Phase 50).
- Contracts and billing (Phases 51–52).
- Any contract change in `@horizon/contracts`. Quote events carry no lines, and the
  order events are untouched.

## Changes made during implementation

- **A price arriving before its item was lost.** Sales' `recordPrice` only updated an
  existing row, so a `catalog.price.changed` delivered before `catalog.item.created`
  vanished. The second local smoke run hit it. It now upserts with a placeholder
  description that the item event replaces, with an e2e for the reversed order.
- **Reads enrich lines in the query layer.** Quote and order snapshots stay domain
  objects; the database read adds `kind` to each line, so no aggregate changed.
