# 53. NFC-e is a separate model over the same Sales shipment

- Status: accepted and implemented locally; exercised in simulation
- Date: 2026-09-26

## Context

Phase 46 adds the NFC-e (model 65), the consumer's invoice. The MOC separates models 55
and 65. They share the XML schema package (PL 010f), the access-key layout and the
item and tax groups. Model 65 differs in:
- its `ide` (print type 4, final consumer, presence);
- its recipient, who is optional and never carries an IE;
- a mandatory payment group;
- the supplementary `infNFeSupl` group with the QR code, outside the signature;
- the auxiliary document (DANFE NFC-e);
- synchronous authorization, and a short delay allowed between emission and
  authorization (NT 2025.001 §02.4).

The roadmap forbids copying the model 55 generator with another `mod`.

Horizon has no counter (cashier) sale. Sales records shipments; Inventory takes the
stock and Financial posts the receivable when a shipment is dispatched (ADR 0048). No
fact records how a consumer paid.

## Decision

The consumer sale is the **same Sales shipment origin** that an NF-e uses. The caller
chooses `model: '65'` when creating the draft, with the version 2 request. The stock and
money effects stay the dispatch's, as for model 55.

- **One sale, one model.** The first document of an intent fixes its model. The service
  and an insert trigger refuse the other model for that intent and for its successors
  (`MODEL_CONFLICT`). The partial unique index still allows one live document per
  intent.
- **Eligibility is derived.** Readiness requires:
  - a recipient profile that is a final consumer and not an ICMS contributor;
  - the recipient's UF equal to the issuer's;
  - an active model 65 capability row (`consumer-sale`) with its own reviewed calculation
    fixture.

  Otherwise it answers `CONSUMER_NOT_ELIGIBLE` or `CAPABILITY_UNSUPPORTED`.
- **A separate builder.** `fiscal/src/nfce65/` holds the data schema, XML, QR code,
  signature placement, DANFE NFC-e and simulator. It shares only neutral parts with
  model 55:
  - the key algorithm;
  - PL 010f validation and the XML-DSig algorithms;
  - the item, IBS/CBS and totals groups.
- **QR code version 3, online.** `<url>?p=<key>|3|<tpAmb>`, without a CSC. Simulation
  URLs use `nfce.simulacao.horizon.invalid`, a name that never resolves. The official
  per-UF URLs belong to the homologation gate.
- **`dhEmi` is the signing instant.** An issue on another calendar day than the locked
  calculation is refused (`READINESS_STALE`). A retry reuses the bytes already bound, so
  a crash cannot produce a second emission time.
- **Model-specific authority.** The simulator authorizes synchronously and records when
  it first received the document. It rejects a document it first sees more than 5
  minutes after `dhEmi`. After an outage the key is consulted before any resend. A late
  recovery is rejected and corrected by a successor revision with a new number, so only
  one document of the sale ends authorized.
- **Event flows.** Model 65 has cancellation (event 110111) inside a reviewed window,
  counted from the protocol (`CANCELLATION_WINDOW_ELAPSED` after it). It has no
  correction letter, and returns or complements of an NFC-e are refused.
- **Outcome event.** `fiscal.consumer-document.simulation-outcome` names the shipment
  whose dispatch owns the effects. It carries no key, QR code, XML or consumer data.
  The model 55 events keep their `model: '55'` literal.
- **Versioned contracts.** Published schemas are not widened in place (ADR 0030):
  - the create request gains a version 2;
  - the document read gains a version 3;
  - the kind catalogue gains a version 2.

## Consequences

- The reviewed issuance profile carries the model 65 facts in a `consumer` block:
  presence, payment indicator and method, nature and cancellation window. The local
  rollout sets delivery (4) and on-account "crédito loja" (05), because the dispatch
  posts a receivable. Both are the owner's provisional simulation reading.
- A **counter sale** needs a Sales fact with its payment and an Inventory handoff.
  **Offline contingency** (`tpEmis` 9) needs the contingency manual and a recovery test.
  Both are catalogued as unsupported.
- Homologation and production of model 65 need:
  - the ENCAT QR and key-query URLs of the issuer's UF;
  - the NFC-e authorizer endpoints;
  - a credentialed issuer and the UF's cancellation window;
  - their own capability rows and evidence.
- The `/capabilities` listings keep their model 55 schemas. The model 65 support is read
  from the version 2 kind catalogue and the capability matrix.
