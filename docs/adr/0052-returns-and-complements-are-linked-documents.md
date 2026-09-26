# 52. Returns and complements are linked documents over owner facts

- Status: accepted and implemented locally; exercised in simulation
- Date: 2026-09-26

## Context

Phase 45 issues NF-e model 55 documents that point at an earlier document:
- a customer's return of a shipment (`finNFe` 4, inbound);
- the tenant's return of a purchase to its supplier (`finNFe` 4, outbound);
- a complement of the value of a sale (`finNFe` 2).

Each of them has an owner fact, except the complement. Sales records a return origin
when a shipment comes back. Procurement publishes `procurement.receipt.returned`. The
same facts already move the stock back (Inventory) and withdraw what was owed
(Financial). A fiscal document that also moved stock or money would count the return
twice.

A return can also over-return. Two returns of one sale line, or two receipts returned
against one supplier invoice line, must never add up to more than the original. The
original must also stay alive while something points at it. The model 55 correction
letter (event 110110) is the only approved correction flow after authorization, and
no other model has one yet.

## Decision

A return or complement starts from a **linked origin**: an immutable, sealed snapshot of
the owner facts, the recipient, the lines and the documents it references.
- A sale return is derived only from the Sales return of the shipment. It references
  that shipment's authorized sale.
- A purchase return is derived only from the projected Procurement return. It
  references the supplier NF-e(s) that the Phase 44 reconciliation tied to the receipt.
- A value complement is a reviewer request with a reason. It references an authorized
  sale.

There is one linked origin per owner fact, whatever key a retry uses.

Quantities are conserved per original line, by the service under a lock and again by an
insert trigger. A linked origin stops holding its quantities only when its latest
document is `cancelled`. A rejected linked document keeps them and is corrected by a new
revision from the same linked origin. A complement records its value on its own line
and never changes the original's calculation or XML. The original can be referenced
only while `authorized`. Its cancellation is refused, by the service and by a trigger on
the cancellation command, while a live linked origin or an unresolved correction letter
points at it.

Each kind is a catalogued contract with:
- `finNFe` and `tpNF`, and the reference it must carry;
- the source fact, the stock owner and the money owner;
- its own capability operation and reviewed calculation fixture.

Kinds without an owner fact or a reviewed rule are catalogued as unsupported, with the
reason: remittance and its return, quantity and tax complements, adjustment, and credit
and debit notes. Event flows are catalogued per model. Model 55 has cancellation and
the correction letter; models 65 and NFS-e have none. The correction letter requires an
attestation that it changes no value, quantity, party or date. It never changes the
document status.

Fiscal correlates effects but does not create them. The links view and the
`fiscal.linked-document.simulation-outcome` event name the id each owner keys its effect
by (`shipmentId` or `receiptId`). They list only the reversals Financial actually
published. The event carries no access key, XML or personal data.

## Consequences

- Returns are calculated as reversals (purpose `return`, negative direction) under their
  own reviewed rules. The XML carries magnitudes, with `finNFe` and `NFref` giving the
  meaning.
- The calculation input gains `complementValue`, allowed only for purpose
  `complementary`, with zero quantity and price. That matches the complement line
  (`qCom` 0, `vUnCom` 0, `vProd` equal to the value).
- A cancelled linked document releases its quantities, but its owner fact is spent: a
  second return document for the same shipment or receipt needs a new owner fact.
- A purchase return uses the buyer's units and Procurement's prices and references the
  supplier keys. Mirroring the supplier's own codes and units is future work.
- Financial withdraws only a draft payable when goods are returned. A posted one is
  reversed by a person, and Fiscal shows the reversal only once Financial publishes it.
- Homologation and production of linked documents, correction letters, and interstate
  operations need their own capability rows and evidence.
