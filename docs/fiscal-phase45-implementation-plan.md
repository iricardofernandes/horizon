# Phase 45 — Returns, complements and correction events

Status: **delivered for simulation on 2026-09-26**
([evidence](fiscal-phase45-evidence.md)). This is the execution
record for [Phase 45 in the fiscal roadmap](fiscal-implementation-plan.md#45--returns-remittance-and-complementary-documents).
The environment is still simulation-only. Every document in this phase is an NF-e model
55 authorized by the deterministic simulator. Nothing contacts an authority, and Fiscal
never publishes a stock, receivable or payable effect.

## Result

Horizon can issue three **linked documents**. Each one references an authorized
original, is issued through the existing Phase 42 lifecycle (draft, ready, queued,
authorized) and stays readable next to the original:

| Kind | What happened | `finNFe` / `tpNF` | Referenced document |
|---|---|---|---|
| `sale-return` | A customer returned a shipment (`sales.fiscal-origin.recorded`, purpose `return`). | 4 / 0 (inbound) | The authorized sale NF-e of that shipment. |
| `purchase-return` | The tenant sent goods back to a supplier (`procurement.receipt.returned`). | 4 / 1 (outbound) | The supplier NF-e(s) reconciled with that receipt in Phase 44. |
| `value-complement` | A reviewer records a price difference on an authorized sale. | 2 / 1 | The authorized sale NF-e. |

An authorized model-55 document can also receive a **correction letter** (CC-e, event
110110). It changes no value, quantity, party or date, and it never edits the authorized
XML. Cancellation (event 110111) already exists since Phase 42. Phase 45 adds one rule to
it: an original cannot be cancelled while an active linked document or an unresolved
correction letter points at it.

Every other kind is catalogued as `unsupported`, with the reason, and cannot be issued:
remittance and its return, quantity or tax complement, adjustment (`finNFe` 3), and the
reform's credit and debit notes (`finNFe` 5 and 6).

## Starting point

- Sales already emits `sales.fiscal-origin.recorded` v1 with purpose `return` when a
  shipment comes back (whole shipment). Fiscal records it as an intent, but readiness
  refuses every purpose other than `original`.
- Phase 44 projects `procurement.receipt.returned` (returned quantity per receipt line)
  and `financial.payable.reversed`. It also keeps the supplier NF-e and the
  reconciliation lines that tie invoice lines to receipt lines.
- The calculation engine already knows purpose `return` (formula
  `RETURN_LINE_NET_TIMES_RATE`, negative direction) and requires `referencedDocumentId`
  for it. Purpose `complementary` exists in the schema but has no way to carry a value
  without a quantity.
- The XML builder hardcodes `tpNF = 1`, `finNFe = 1`, no `NFref`, and the nature
  "Venda de mercadoria". The issuance profile is bound to a single capability.
- Cancellation is a durable event workflow (`cancellation_pending`, `cancellation_unknown`,
  `cancelled`, or back to `authorized` on refusal). There is no correction letter.

## Decisions frozen by this plan

1. **A kind is a catalogued contract.** `fiscal/src/document-kinds.ts` states, per
   kind, the model, `finNFe`, `tpNF`, CFOP policy, reference rule, source fact,
   quantity/value rule, stock owner, money owner and required capability operation.
   Anything not in the catalogue as `supported` is refused with `KIND_UNSUPPORTED`
   before a draft exists. Event flows are catalogued per model: model 55 has
   cancellation and correction letter; models 65 and NFS-e have none yet, so no generic
   "correct" action exists for them.
2. **Linked origins freeze owner facts.** A linked origin is an immutable, sealed
   snapshot, like a Phase 42 manual origin. It holds the kind, the reference, the
   recipient, the lines and the source ids:
   - `sale-return` is built only from the Sales return intent of the shipment (one per
     intent). Lines and prices are the ones Sales recorded.
   - `purchase-return` is built only from a projected Procurement return (one per
     receipt). Quantities are the projected returned quantities, and prices are the
     receipt's.
   - `value-complement` is a reviewer request with a reason of at least 10 characters,
     naming lines of the referenced document and a positive amount per line.
3. **Conservation is enforced twice.** Each linked line records its reference key (the
   original line) and the reference quantity. Across all linked origins that are not
   void, the quantity returned against a reference line can never exceed it. A service
   lock checks this, and an insert trigger checks it again. A linked origin is void only
   when its latest document is `cancelled`. A rejected linked document keeps its
   quantities reserved until its corrected revision is issued or it is cancelled.
   - Sale return: the reference line is the sale document's line, and its quantity is
     the shipped quantity.
   - Purchase return: the reference line is the supplier invoice line. Its quantity is
     what the Phase 44 reconciliation allocated to it (in buyer units). A return is
     refused when the returned quantity of a receipt line is not fully covered by
     reconciled invoice lines (`REFERENCE_INCOMPLETE`).
   - Complement: amounts are recorded independently and never change the original's
     quantities, value or calculation.
4. **A reference must be alive.** A linked origin can be created only while its
   referenced sale document is `authorized` (a supplier NF-e only needs a committed
   reconciliation). The original cannot be cancelled while a non-void linked origin
   points at it. This is checked in the service and by a trigger on the cancellation
   command.
5. **Owners keep the effects; Fiscal correlates them.** The links view names the owner
   and the id each owner keys its effect by:
   - sale return: Inventory and Financial act on `sales.shipment.returned` for the
     `shipmentId`;
   - purchase return: Inventory and Financial act on `procurement.receipt.returned` for
     the `receiptId`, and the payable titles Fiscal has seen reversed are listed.
   
   Fiscal cancellation of a linked document changes no stock or money anywhere.
6. **Taxes come from reviewed rules, not from the original.** Returns use purpose
   `return` rules (engine direction negative, as Phase 41 defined). Complements use
   purpose `complementary` rules. Both are Phase 45 fixtures over the same RTC V0057
   reference rates, approved for simulation only. The XML carries magnitudes: `finNFe`,
   `tpNF` and `NFref` give the direction. A complement line has `qCom = 0`,
   `vUnCom = 0` and `vProd` equal to the complemented value. The calculation contract
   gains an optional `complementValue` per line, allowed only for purpose
   `complementary`.
7. **One capability row per kind.** The capability key already includes the operation.
   The new operations are `sale-return`, `purchase-return` and `value-complement`, each
   with its own calculation fixture. The issuance profile keeps its base capability and
   gains a `linked` map from kind to `{capabilityId, cfop, natureOperation}`, so each kind's CFOP
   and nature are reviewed configuration rather than code.
8. **Correction letter is its own event flow.** It requires an authorized simulated model
   55 document and a text of 15 to 1000 characters. The reviewer must also attest that the
   text does not change tax values, quantities, parties or dates (the legal limits the
   event's `xCondUso` states). Each letter:
   - gets the next sequence (1 to 20), and a later letter supersedes the earlier ones;
   - is signed and validated against the PL 010d envelope, with the event detail checked
     in code (as for cancellation);
   - is queued durably and processed by the worker with the same
     submit, unknown, consult discipline.

   It never changes the document status. Its request, response and protocol are separate
   artifacts.
9. **Linked outcomes have their own event.** `fiscal.linked-document.simulation-outcome`
   v1 carries:
   - the kind and the outcome (`authorized`, `rejected`, `cancelled`);
   - the referenced document or import ids;
   - the source (`sales` shipment, `procurement` receipt, or `fiscal` review);
   - the stock and money owner correlation ids and the adapter version.

   It carries no access key, XML or personal data. The existing
   `fiscal.document.simulation-*` events stay unchanged for sale documents.

## Persistence (migration `0047_phase45_linked_documents.sql`)

| Table / change | Purpose |
|---|---|
| `fiscal_linked_origins` | Immutable sealed snapshot: kind, source, recipient, establishment, actor, reason digest. Unique per `(tenant, kind, source_id)`. |
| `fiscal_linked_origin_idempotency` | Command idempotency for linked-origin creation. |
| `fiscal_linked_references` | Referenced sale document or supplier import (and its key) per linked origin. |
| `fiscal_linked_origin_lines` | Line, item, reference key, reference quantity, quantity and amount; conservation trigger. |
| `fiscal_documents.linked_origin_id` | Third origin kind. The origin CHECK becomes "exactly one of three", plus one non-terminal document per linked origin. |
| `fiscal_correction_letters`, `fiscal_correction_letter_observations` | Letter facts (sequence, text digest, attestation, actor), mutable lease columns, immutable observations. |
| Artifact kinds | `correction_request`, `correction_response`, `correction_protocol`. |
| Cancellation guard | A trigger on `fiscal_dispatch_commands` refuses a `cancellation` while a non-void linked origin references the document or a letter is unresolved. |

Every table has forced RLS, `tenant_id`-leading keys and `horizon_app` grants of
`SELECT, INSERT` (plus lease columns on the letters). Facts are append-only.

## HTTP and contract surface (`@horizon/contracts` 0.34.0)

| Route | Permission | Behaviour |
|---|---|---|
| `GET /fiscal/document-kinds` | `read` | The catalogue with support status and reasons. |
| `POST /fiscal/linked-origins` | `draft:create` | `Idempotency-Key`. Body by kind: `{kind:'sale-return', intentId}`, `{kind:'purchase-return', receiptId}`, `{kind:'value-complement', referencedDocumentId, reason, lines:[{lineId, amount}]}`. `201` new, `200` existing, `422` with a stable code (`KIND_UNSUPPORTED`, `REFERENCE_NOT_AUTHORIZED`, `REFERENCE_INCOMPLETE`, `QUANTITY_EXCEEDED`, `SOURCE_NOT_PROJECTED`). |
| `POST /fiscal/documents` | `draft:create` | Accepts `linkedOriginId` besides `intentId` / `manualOriginId`. |
| `POST /fiscal/documents/:id/corrections` | `draft:create` | Also creates the successor of a rejected linked document from the same linked origin. |
| `GET /fiscal/documents/:id/links` | `read` | Its reference, the documents linked to it, and the conserved quantities and owner correlations. |
| `POST /fiscal/documents/:id/correction-letters` | `cancellation:request` | `Idempotency-Key`, `{text, attestation: true}`; `202`. |
| `GET /fiscal/documents/:id/correction-letters` | `read` | Letters with sequence, status and digests. |

Validate, issue, status and cancellation routes are unchanged and work for linked
documents.

## Work packages and order

| Step | Content | Evidence |
|---|---|---|
| 45.1 Contracts | Calculation `complementValue`; linked-origin, links, kinds and correction-letter schemas; the linked outcome event. Minor bump, baseline, catalogue and pins. | Contract specs, compatibility gate, pin check. |
| 45.2 Catalogue and fixtures | `document-kinds.ts`; Phase 45 approved source with return and complement rules; engine support for `complementValue`. | Unit: catalogue refusals, return and complement calculations and replay. |
| 45.3 Persistence | Migration 0047 with the conservation and cancellation triggers. | e2e: trigger refusals, RLS, immutability. |
| 45.4 Linked origins | Service for the three kinds, conservation under lock, idempotency. | e2e: each kind, over-return refused, reference checks. |
| 45.5 Drafts and readiness | Linked drafts and successors; readiness derives capability, purpose and reference per kind. | e2e: ready for each kind; unsupported tuple refused. |
| 45.6 XML and issuance | `tpNF`, `finNFe`, `NFref`, CFOP and nature per kind; complement lines with zero quantity; profile `linked` map. | Unit: XSD-valid return and complement XML; e2e issue to authorization. |
| 45.7 Events and cancellation | Linked outcome event; cancellation guard. | e2e: guard refuses, then allows after the linked document is cancelled. |
| 45.8 Correction letter | Event builder, service, worker path, simulator, artifacts. | Unit: schema and signature; e2e: registered, rejected, unknown then consulted. |
| 45.9 API and worker | Routes, permissions, wiring. | API spec. |
| 45.10 Evidence | Exit tests below and a local-stack smoke through Kong. | `fiscal-phase45-evidence.md`. |
| 45.11 Docs | ADR 0052, capability rows, roadmap status. | Docs. |

## Changes made during implementation

- A sale return is requested by `shipmentId`, the id the operator knows, not by Fiscal's
  internal intent id. A purchase return names the issuing establishment, because the
  receipt does not carry it.
- A reviewed kind's CFOP and nature live in the issuance profile's `linked` map; the
  local rollout (`phase45:rollout`) prints it next to the three capability ids.
- Phase 44 keyed an allocation by invoice line and order line only, so one invoice line
  could not cover two partial receipts of the same order line. The service check and the
  primary key now include the receipt (migration 0047).
- Financial withdraws only a draft payable when goods go back. A posted one is reversed
  by a person, and the links view lists only reversals Financial published.
- The `/capabilities` listings keep their `normal-sale` schema; linked kinds and their
  support are read from `/document-kinds`.

## Exit evidence (from the roadmap)

- The original and every linked document stay readable: XML, protocol, DANFE and the
  links view. Cancelling a linked document keeps the original authorized, and a refused
  cancellation keeps the document authorized with the refusal on record.
- Every correction has a reason:
  - corrected revisions and complements need a reason of at least 10 characters;
  - correction letters need their text and the attestation;
  - cancellations keep their Phase 42 justification.
- Replaying the complete event history yields the same quantities and financial links:
  - Sales and Procurement origins, receipts, returns and payables are redelivered;
  - linked-origin commands are retried;
  - a digest of the conserved quantities and owner correlations is unchanged, and no
    second linked origin, document or outbox event appears.
- Returned quantity cannot exceed the original:
  - a partial purchase return passes;
  - an over-return is refused by the service and by the trigger;
  - two receipts returned against one supplier invoice line stay within that line.
- A complementary value is recorded independently, and the original's calculation and
  XML digests are unchanged.
- Neither XML import nor fiscal cancellation duplicates stock or money: Fiscal's outbox
  holds only fiscal events, and in the local stack Inventory and Financial show one
  effect per owner fact.
- Unsupported kinds cannot be issued: remittance, adjustment, credit and debit notes are
  refused at origin creation, and a linked document without an active capability row
  cannot become ready.

## Non-goals

- Homologation or production transmission of any linked document or event.
- Remittance flows (no Inventory fact for goods leaving to third parties yet),
  adjustment, credit/debit notes, quantity and tax complements.
- Interstate operations, and CFOP selection beyond the reviewed profile map.
- Mirroring the supplier's units and codes in a purchase return (buyer units and
  Procurement prices are used, with the supplier keys referenced).
- Creating a Financial adjustment for a complement; Financial owns it.
- Operator screens (Phase 48).
