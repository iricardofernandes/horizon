# Phase 46 — NFC-e model 65 as a separate capability

Status: **delivered for simulation on 2026-09-26**
([evidence](fiscal-phase46-evidence.md)). This is the execution
record for [Phase 46 in the fiscal roadmap](fiscal-implementation-plan.md#46--nfc-e-model-65-as-a-separate-capability).
The environment is still simulation-only. Every NFC-e in this phase is authorized by a
deterministic model-65 simulator. Nothing contacts an authority, and Fiscal never
publishes a stock, receivable or payable effect.

## Result

Horizon can issue an **NFC-e (model 65)** for a consumer sale, as its own capability:
- its own XML: `mod` 65, DANFE NFC-e print type, final consumer, presence, payment
  group and the supplementary `infNFeSupl` group with the QR code;
- QR code version 3 (online), which needs no CSC;
- its own numbering series, calculation fixture and capability row;
- its own auxiliary document, the DANFE NFC-e, laid out after the official manual, with
  a QR image that decodes to the XML's `qrCode`;
- its own simulated authority: synchronous, and it rejects a late emission;
- cancellation (event 110111) inside a reviewed window.

Model 55 keeps its code paths, events and tests unchanged.

## Sources pinned for this phase

| Source | Retrieved | SHA-256 | Used for |
|---|---|---|---|
| PL 010f v1.04 (already pinned in Phase 42) | 2026-09-21 | `b8589490…4b95998` | XSD: `mod` 65, `infNFeSupl`, the five `qrCode` patterns including v3 online and offline |
| [NT 2025.001 v1.02](https://www.nfe.fazenda.gov.br/portal/exibirArquivo.aspx?conteudo=3NLMgy80wTE=), published 02/09/2025, 1,027,385 bytes | 2026-09-26 | `44b71f16bf1196f35efe0f8645d7992305b37506ffd2e44fe7fb3350616a930d` | QR v3 layout (§04), rules ZX02-220 to ZX02-338, synchronous single-document authorization (§02.3), the 5-minute emission delay for NFC-e (§02.4) |
| [Manual de Padrões Técnicos do DANFE NFC-e e QR Code v6.0](https://www.nfe.fazenda.gov.br/portal/exibirArquivo.aspx?conteudo=k/IuuaW4YiY=), March 2025, 1,887,904 bytes | 2026-09-26 | `bf906cc212f1edd19b1df7d1cdf4fbf5e73c3fec77567b6e69fa74453c95db5e` | Divisions I–IX of the DANFE NFC-e, 25 mm minimum QR with quiet zone, "CONSUMIDOR NÃO IDENTIFICADO", homologation and contingency texts, QR v3 parameters (§4.4) |

The machine-readable list is `docs/fiscal-phase46-source-manifest.json`. The ENCAT list
of official QR and key-query URLs per UF, the NFC-e authorizer endpoints and the
contingency manual (MOC Anexo IV) are **not** pinned: they gate homologation and
contingency, which this phase does not enable.

## Starting point

- `fiscal_documents.model` already accepts `65`, and numbering counters are keyed by
  `(tenant, establishment, environment, model, series)`, so model 65 has its own series.
- Capabilities, rules and the calculation input already accept model `65`. No rule,
  fixture or capability row exists for it.
- Every service refuses anything that is not model 55: readiness, issuance, dispatch,
  cancellation, the API and the published events (`model: '55'` literals).
- The Parties fiscal profile already carries `kind` (person or organization), a CPF or
  CNPJ, `taxpayerIndicator` and `finalConsumer`.
- One live document per Sales intent is enforced by a partial unique index; a rejected
  or cancelled document can be followed by a successor revision.
- Sales has no counter (cashier) sale and records no payment method. The shipment
  dispatch already moves the stock (Inventory) and posts the receivable (Financial).
- The document-kind catalogue says model 65 has no event flows.

## Decisions frozen by this plan

1. **The consumer-sale origin is the Sales shipment.** A model 65 document is created
   from the same `sales.fiscal-origin.recorded` intent (purpose `original`) as an NF-e,
   with `model: '65'` in `POST /fiscal/documents`. The sale's stock and money effects
   are the dispatch's, exactly as for model 55. A **counter (cashier) sale** needs a
   Sales fact with its payment and an Inventory handoff that do not exist, so it is
   catalogued as unsupported (roadmap item 2).
2. **One sale, one model, one live document.** The first document of an intent fixes
   its model. A second request for the same intent with the other model is refused
   (`MODEL_CONFLICT`), and a database trigger enforces the same rule for successors.
   The existing partial unique index keeps one live document per intent. Replaying the
   Sales origin or retrying a create returns the same document.
3. **Eligibility is derived, not chosen by the caller.** Readiness for model 65 requires:
   - the recipient's effective profile says `finalConsumer = true` and
     `taxpayerIndicator = 'non-contributor'` (NFC-e carries `indIEDest` 9 and no IE);
   - the recipient's UF equals the issuer's (NFC-e is intrastate, `idDest` 1);
   - an active model 65 capability for the establishment and UF, operation
     `consumer-sale`, fixture `rtc-v0057-model65-consumer-sale-sp-2026-01`.

   Anything else is unsupported, with a reason. Model 55 readiness is unchanged.
4. **Model 65 has its own builder.** `fiscal/src/nfce65/` holds the data schema, the XML
   serializer, the QR code, the DANFE NFC-e and the simulator. It does not reuse the
   model 55 serializer with another `mod`. Only neutral pieces are shared: the access-key
   algorithm (generalized to 55 and 65), the PL 010f schema validation, the XML-DSig
   signer and the item/IBS-CBS rendering. What differs is written for model 65:
   - `ide`: `mod` 65, `tpImp` 4 (DANFE NFC-e), `indFinal` 1, `idDest` 1, `finNFe` 1,
     `tpEmis` 1, `indPres` from the reviewed profile (1 in person, 4 home delivery);
   - `dest`: CPF or CNPJ, name, address (required for delivery), `indIEDest` 9, no IE;
   - `pag`: indicator and method from the reviewed profile, `vPag` equal to `vNF`;
   - `infNFeSupl` after `infNFe` and before the signature, outside the signed reference.
5. **QR code version 3, online only.** `qrCode` is
   `<query URL>?p=<access key>|3|<tpAmb>`, and `urlChave` is the key-query URL (NT
   2025.001 §04). No CSC is stored. In simulation both URLs point to
   `nfce.simulacao.horizon.invalid`, a reserved name that never resolves, so a simulated
   receipt can never send a consumer to a real SEFAZ page. Official per-UF URLs belong to
   the homologation gate.
6. **`dhEmi` is the issue instant.** NFC-e expects authorization within 5 minutes of
   emission (NT 2025.001 §02.4). The XML is built and signed when `issue` is called, with
   `dhEmi` in the issuer's timezone. If that local date differs from the calculation's
   issue date, issuance is refused until the document is validated again.
7. **The simulated authority is model-specific.** `DeterministicNfce65Simulator`:
   - authorizes synchronously (no receipt), with outcomes keyed by the command identity;
   - rejects a document whose first accepted submission comes more than 5 minutes after
     `dhEmi` (code `SIMULATED_LATE_EMISSION`), and records the submission instant in the
     response so a restart replays the same decision;
   - puts `authorizedAt` in the protocol, which the DANFE and the cancellation window read.
8. **An outage never produces a second document.** Unknown outcomes are consulted before
   any resend, as in model 55. If the authority returns only after the 5-minute limit,
   the document is rejected. It is then corrected by a successor revision of the same
   origin, with a new number and `dhEmi`. **Offline contingency (`tpEmis` 9) is not
   implemented**: its rules (MOC Anexo IV) and a recovery test are not pinned, so it is
   catalogued unsupported (roadmap item 2).
9. **The DANFE NFC-e follows the manual.** It is an 80 mm-wide PDF with divisions I–IX:
   - header, items, totals (discounts and additions only when present), payment;
   - "Consulte pela Chave de Acesso em" with the URL and the key in 11 blocks of 4;
   - a QR at least 25 mm with its quiet zone;
   - `CONSUMIDOR CPF:` / `CNPJ:` with the name and delivery address, or
     `CONSUMIDOR NÃO IDENTIFICADO`;
   - number, series, local emission time and the protocol with its local time;
   - in the fiscal message area, "SIMULAÇÃO – SEM VALOR FISCAL", mirroring the mandatory
     homologation text. A preview also says "NÃO AUTORIZADA".
10. **Cancellation is the only model 65 event flow.** Event 110111 reuses the PL 010d
    envelope with the model 65 key. It is allowed only inside the window in the reviewed
    profile, counted from the protocol's `authorizedAt`; after it, it is refused with
    `CANCELLATION_WINDOW_ELAPSED`. The local rollout sets 30 minutes as the owner's
    provisional reading for simulation. The UF's legal window is not pinned and stays
    part of the Fiscal review. Correction letters, linked returns and complements of an
    NFC-e are refused. Substitution cancellation (110112) is catalogued as unavailable.
11. **Consumer outcomes have their own event.** `fiscal.consumer-document.simulation-outcome`
    v1 carries the outcome (`authorized`, `rejected`, `cancelled`), the document,
    revision, the shipment id, and the stock and money owners (`sales.shipment.dispatched`
    for Inventory and Financial). It carries no access key, QR, XML or consumer data. The
    model 55 `fiscal.document.simulation-*` events stay unchanged.
12. **Taxes come from a reviewed model 65 fixture.** The Phase 46 source reuses the RTC
    V0057 reference rates for operation `rtc-v0057-model65-consumer-sale`, with its own
    package, review and fixture, approved for simulation only.
13. **The profile carries the reviewed model 65 facts.** The issuance profile gains a
    `consumer` block: `capabilityId`, `natureOperation`, `presence`, `payment`
    (`indicator`, `method`) and `cancellationWindowMinutes`. The local rollout sets
    presence 4 (delivery, since the origin is a shipment) and payment `1`/`05` (on
    account, "crédito loja"): the dispatch posts a receivable, so the consumer pays later.
    Both are the owner's provisional reading for simulation.

## Persistence (migration `0048_phase46_nfce.sql`)

| Change | Purpose |
|---|---|
| Trigger `fiscal_documents_intent_model_guard` | All documents of one intent share the model of the first one. |
| CHECK on `fiscal_documents` | A model 65 document has a Sales intent (no manual or linked origin). |
| Linked-origin guard | A linked origin cannot reference a model 65 document (service and trigger). |
| Correction-letter guard | A correction letter cannot target a model 65 document (trigger). |

## HTTP and contract surface (`@horizon/contracts` 0.35.0)

| Surface | Change |
|---|---|
| `POST /fiscal/documents` | `model` accepts `'65'` for a Sales intent. `409 MODEL_CONFLICT` when the intent already has the other model. |
| Document schemas | `model` is `'55' \| '65'`. |
| `GET /fiscal/document-kinds` | Adds `consumer-sale` (model 65, supported) and the unsupported `counter-sale` and `consumer-sale-offline`. Event flows: model 65 has `cancellation`. |
| `POST /fiscal/documents/:id/cancellation-requests` | Works for model 65 inside the window; `409 CANCELLATION_WINDOW_ELAPSED` after it. |
| Event `fiscal.consumer-document.simulation-outcome` v1 | New. |

Validate, issue, status, artifacts and corrections work unchanged for model 65.

## Work packages and order

| Step | Content | Evidence |
|---|---|---|
| 46.1 Sources | Manifest and source register rows for NT 2025.001 and the DANFE NFC-e manual. | Digests recorded. |
| 46.2 Contracts | Model enum, kinds, problem codes, consumer outcome event; 0.35.0, baseline, catalogue, pins. | Contract specs, compatibility gate. |
| 46.3 Model 65 core | Access key for 65; `nfce65` data schema, XML, QR v3; signature placement. | Unit: XSD-valid XML, QR pattern, signature covers `infNFe` only, refusal of a model 55 key. |
| 46.4 DANFE NFC-e | 80 mm PDF with divisions I–IX and QR image. | Unit: QR image decodes to `qrCode`; required texts present. |
| 46.5 Simulator | Synchronous model 65 simulator with the late-emission rule. | Unit: deterministic outcomes and lateness. |
| 46.6 Persistence | Migration 0048. | e2e: triggers refuse a model switch and model 65 references. |
| 46.7 Scenario and readiness | Phase 46 approved source; readiness per model with eligibility. | e2e: ready; contributor, interstate and inactive capability refused. |
| 46.8 Issuance and worker | Issue builds and signs model 65; worker routes by model and renders the DANFE NFC-e. | e2e: issue to authorization; separate numbering. |
| 46.9 Cancellation and events | Window check; consumer outcome event; model 65 refusals elsewhere. | e2e: cancelled inside, refused after; no linked or correction flow. |
| 46.10 API and rollout | Routes, error mapping, `phase46:rollout` CLI. | API spec. |
| 46.11 Evidence | Exit tests below and a local-stack smoke through Kong. | `fiscal-phase46-evidence.md`. |
| 46.12 Docs | ADR 0053, capability rows, roadmap status. | Docs. |

## Changes made during implementation

- **Versioned schemas.** Widening the published `model: '55'` literals was flagged by the
  compatibility gate as 7 breaking changes. The published schemas stay as they are, and
  these gained new versions:
  - the create request (v2);
  - the document read (v3);
  - the ready document (v2);
  - the kind catalogue and its entry (v2).

  The route `/documents/:id/v2` now answers with the v3 schema. A model 55 document still
  satisfies v2.
- **Conflict message.** `MODEL_CONFLICT` keeps the "Conflicting fiscal draft" prefix
  that the Phase 40 e2e expects, and the API maps it by error type.
- **Shared line code.** The line and totals building moved from `issuance.ts` to
  `nfe-lines.ts` and `nfe-values.ts`. The model 55 XML digest pinned in its test is
  unchanged.
- **Simulator time.** A document the simulated authority received on its first send is
  decided at a deterministic instant within a minute of `dhEmi`. Only a resend after
  "timeout before accept" uses the clock, and the response records it.
- **No Lei 12.741 message.** Division IX of the DANFE NFC-e prints no approximate tax
  total, because the calculation does not produce one.

## Exit evidence (from the roadmap)

- Model 65 passes its own XSD (PL 010f), QR and rendering fixtures: the QR follows the v3
  online layout, and the DANFE's QR image decodes to it.
- Authority-state fixtures:
  - **duplicate sale:** the same intent cannot get a second live document or a document
    of the other model, and replayed origins and retried commands create nothing new;
  - **outage:** an unknown outcome is consulted before resending; a late recovery is
    rejected and corrected by a successor, and only one document ends authorized;
  - **cancellation:** accepted inside the window, refused after it, and a refused
    cancellation keeps the NFC-e authorized.
- One sale has one authorized consumer document and one stock and money effect: Fiscal's
  outbox holds only fiscal events, and in the local stack Inventory and Financial show
  one effect for the shipment.
- The model 55 tests stay unchanged and green.
- The support matrix names the exact simulated tuple; every other model 65 tuple stays
  unsupported.

## Non-goals

- Homologation or production of model 65. It needs the ENCAT URLs, the NFC-e
  authorizer endpoints, a credentialed issuer and a Fiscal review. It stays the
  activation gate, like the Phase 43 official round trip. The owner's standing
  instruction is simulation only.
- Offline contingency (`tpEmis` 9), EPEC, QR code version 2 and the CSC.
- A counter (cashier) sale, payment capture and change (`vTroco`): Sales and Treasury
  own them first.
- Returns, complements and correction letters of an NFC-e; substitution cancellation.
- Operator screens (Phase 48).
