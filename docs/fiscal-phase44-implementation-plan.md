# Phase 44 — Inbound XML and purchase reconciliation

Status: **delivered for simulation on 2026-09-26**
([evidence](fiscal-phase44-evidence.md)). This is the execution record
for [Phase 44 in the fiscal roadmap](fiscal-implementation-plan.md#44--inbound-xml-and-three-way-reconciliation).
The environment is still simulation-only. Nothing in this phase contacts an authority, and
no import creates stock, a payable or an accounting entry.

## Result

A Fiscal reviewer uploads a supplier's NF-e model 55 XML. Fiscal checks the bytes, the
structure, the access key, the recipient and the XML signature. It keeps the original
bytes encrypted and stores the parsed supplier, lines, taxes and totals. Fiscal then
compares the invoice with what Procurement says arrived and what Financial says is owed:

- the supplier's CNPJ is matched to a Party;
- each invoice line is proposed against a received line of that supplier (item, quantity,
  unit price and value);
- conflicts are shown line by line.

The reviewer commits a reconciliation. A clean comparison is `matched`. Any difference
needs an override reason, and the original comparison is kept with it. Only after that
commit does Fiscal publish `fiscal.inbound.matched`. Stock and payables stay with
`procurement.receipt.recorded` and Financial, exactly as today.

## Starting point

- `fiscal_imports` and `inbound_matches` (migration 0007) are empty placeholders: a
  `staged`-only status, no bytes, no lines and no comparison. They are replaced.
- Fiscal consumes no Procurement or Financial event. It has encrypted Party projections
  but no way to find a Party by tax id, and it knows Catalog items only through
  classification revisions (NCM).
- `procurement.receipt.recorded` already carries `receiptId`, `orderId`, `supplierId`,
  the warehouse and each received line (`lineId`, `itemId`, `quantity`, `unitPrice`,
  `lineTotal`). Financial raises the receipt's payable with
  `origin = {type: 'purchase-receipt', documentId: receiptId}` and publishes
  `financial.payable.posted` when it is posted.
- `nfe55/` already has the PL 010f schema check, access-key digit rules, XMLDSig
  verification and the ICP-Brasil CNPJ reader. The `import:review` permission exists
  (admin and reviewer roles).

## Decisions frozen by this plan

1. **The signed bytes are the truth.** Every field is parsed from the canonical `infNFe`
   that the signature authenticated, never from the surrounding document. This prevents
   signature wrapping. The signature must reference `#NFe<key>`, verify with the
   certificate in `KeyInfo`, and the certificate's ICP-Brasil CNPJ root (first 8
   characters) must equal the issuer's. The chain to an ICP-Brasil root is **not**
   verified in this phase, so the result is recorded as `signature: valid-unanchored`.
2. **Authority status is explicit.** No inbound consultation capability exists, so each
   import records `authorityStatus: unverified`. An `nfeProc` with an authorization protocol is
   accepted only when `chNFe` equals the key, `cStat` is 100 or 150, `digVal` equals the
   signature's `DigestValue`, and `tpAmb` equals the NF-e's. A bare `NFe` is accepted
   with `protocol: absent`. Denied or rejected protocols are refused.
3. **What is accepted:** model 55, version 4.00, `tpNF = 1` (outbound from the supplier),
   `finNFe = 1` (normal). The recipient must be the tenant's registered issuer CNPJ,
   compared exactly. Complementary, adjustment and return purposes are Phase 45 and are
   refused as `unsupported`. `tpAmb` is kept: a homologation XML has no fiscal value, and
   the event says so.
4. **Upload hardening.** The raw `application/xml` body is limited to 1 MiB and is
   aborted while streaming once that is exceeded. Invalid UTF-8, a `DOCTYPE` or `ENTITY`
   declaration, a processing instruction other than the XML declaration, and malformed
   XML are refused. The `NFe` element is validated against the pinned PL 010f
   `nfe_v4.00.xsd`.
5. **Identity and duplicates.** An import is unique per `(tenant, access key)`.
   - If the signed `infNFe` digest matches the stored one, the upload is an equivalent
     duplicate: the existing import is returned and nothing new is stored.
   - Any other signed content under the same key is a **conflict**. Its bytes are kept
     encrypted, it is listed on the original import, and it blocks the reconciliation
     until a reviewer dismisses it with a reason.
6. **Supplier lookup uses a blind index.** Party tax ids stay encrypted. Fiscal stores
   `HMAC(HKDF(master, tenant, 'fiscal-party-tax-index-v1'), normalizedTaxId)` for the
   latest revision of each projected Party. Erasure deletes the row. Existing
   projections are indexed by `phase44:reindex-parties`. The same CNPJ in two tenants
   yields unrelated digests.
7. **Operational facts are projections, not commands.** Fiscal consumes:
   - `procurement.order.approved` (ordered lines);
   - `procurement.receipt.recorded` (received lines);
   - `procurement.receipt.returned` (returned lines);
   - `financial.payable.posted` / `reversed`, only for `purchase-receipt` origins.

   The inbox makes a broker replay a no-op. Fiscal writes nothing to those modules and
   publishes no stock, receipt or title event.
8. **Match by stable ids, prove by comparison.** A committed line match names
   `receiptId` and the receipt `lineId` (Procurement's order line id), and the
   item that line carries. Amounts and dates only rank proposals. A proposal comes from
   a remembered supplier-product mapping `(supplier, cProd) → item, conversion factor`
   or, failing that, from the only open received line with the same NCM. The server
   recomputes every comparison at commit time and never trusts figures from the client.
9. **Allocation is hard; differences are reviewable.** Across committed reconciliations,
   the quantity allocated to a receipt line can never exceed what arrived minus what was
   returned. This is checked under row locks and again by a database trigger. Price,
   quantity, unit and total differences, and invoice lines left without a receipt, are
   differences. They can be committed only as `overridden`, with a reason of at least
   10 characters.
10. **One immutable reconciliation per import.** It stores the comparison snapshot and
    its digest, the decision, the reviewer and the idempotency key. A replay with the
    same key and body returns the same reconciliation, and any other body under that key
    is a conflict. A receipt returned or a payable reversed later is shown next to the
    kept decision and never rewrites it. Undoing a reconciliation is out of scope.
11. **Personal data.** An NF-e can name a person (a CPF issuer, addresses), so the
    parsed snapshot is sealed with a tenant key (HKDF, `fiscal-inbound-snapshot-v1`,
    AAD `tenant:import`). The original bytes go to the encrypted artifact store. Only
    non-personal columns are plain: key, series/number, dates, totals, digests, statuses
    and Party ids.

## Persistence (migration `0046_phase44_inbound_reconciliation.sql`)

| Table | Purpose |
|---|---|
| `fiscal_party_tax_index` | Blind tax-id index per Party (latest revision). |
| `fiscal_purchase_orders`, `fiscal_purchase_order_lines` | Approved order lines. |
| `fiscal_purchase_receipts`, `fiscal_purchase_receipt_lines` | Received lines; returned flag and quantity. |
| `fiscal_purchase_payables` | Posted/reversed payables of `purchase-receipt` origins. |
| `fiscal_inbound_documents` | Insert-only import: key, digests, verification, sealed snapshot, supplier match. |
| `fiscal_inbound_conflicts`, `fiscal_inbound_conflict_dismissals` | Conflicting duplicates and reviewer dismissals. |
| `fiscal_supplier_item_mappings` | Append-only `(supplier, cProd) → item, factor` versions. |
| `fiscal_inbound_reconciliations`, `fiscal_inbound_reconciliation_lines` | Immutable decision, comparison and allocations. |

Every table has `tenant_id`, forced RLS and `horizon_app` grants limited to
`SELECT/INSERT`, plus `UPDATE` where a projection must change (the returned flag and the
payable status). Immutable tables use `reject_fiscal_immutable_mutation()`. The empty
placeholders `fiscal_imports` and `inbound_matches` are dropped, with a guard that aborts
if either has rows. The artifact object key admits `inbound_xml` and
`inbound_conflict_xml`.

## HTTP and contract surface (`@horizon/contracts` 0.33.0)

All routes require `import:review`, are tenant-scoped and return `cache-control: private, no-store`.

| Route | Behaviour |
|---|---|
| `POST /imports` | Raw XML body. `201` new, `200` equivalent duplicate, `409` conflicting duplicate (recorded), `422` refused with a stable code. |
| `GET /imports?status=&cursor=&limit=` | Paginated list; `open`, `blocked`, `reconciled`. |
| `GET /imports/:id` | Verification, parsed invoice, supplier match, conflicts, proposals with comparison, and the reconciliation when committed. |
| `GET /imports/:id/xml` | Original bytes with their digest. |
| `POST /imports/:id/conflict-dismissals` | `{conflictId, reason}`. |
| `POST /imports/:id/reconciliation` | `Idempotency-Key`. Body: `{supplierPartyId, lines: [{lineNumber, receiptId, receiptLineId, quantity}] , unmatchedLines: number[], rememberMappings, overrideReason?}`. |

The event `fiscal.inbound.matched` v1 carries:
- `importId`, `accessKey`, `supplierPartyId`, `decision`;
- `receipts: [{receiptId, orderId}]` and the posted payable title ids known at commit;
- `authorityEnvironment`, `signature` and `authorityStatus`;
- `comparisonDigest`, `reviewedBy` and `observedAt`.

It carries no XML and no personal data. No module consumes it yet.

## Work packages and order

| Step | Content | Evidence |
|---|---|---|
| 44.1 Contracts | Inbound HTTP schemas and the event; minor bump, regenerated baseline and catalogue, all pins moved. | Contract specs, compatibility gate, pin check. |
| 44.2 Persistence | Migration 0046, drop guard, allocation trigger. | e2e: RLS, immutability, trigger refusal. |
| 44.3 Verifier | `nfe55/inbound.ts`: hardened parse, XSD, key, recipient, signature, protocol, staged model from signed bytes. | Unit: valid, each mutation refused, wrapping attack, conflicting protocol digest. |
| 44.4 Projections | Ingress handlers for the five events; blind tax index; erasure; reindex CLI. | e2e: replay is a no-op, erasure removes the index. |
| 44.5 Imports | Store bytes and snapshot, dedupe, conflicts, dismissals. | e2e: equivalent duplicate, conflict visible and blocking. |
| 44.6 Reconciliation | Pure proposal/comparison engine; commit with allocation, override, mappings and outbox. | Unit engine; e2e partial-receipt and over-allocation cases. |
| 44.7 API and worker | Routes, streaming limit, consumer bindings, worker wiring. | API spec: roles, limits, error mapping. |
| 44.8 Evidence | Exit tests below, and a local-stack smoke through Kong against the real Procurement and Financial. | `fiscal-phase44-evidence.md`. |
| 44.9 Docs | ADR 0051, capability matrix row, plan and roadmap status, runbook section. | Docs. |

## Changes made during implementation

- Partial receipts of one order repeat the order line's `lineId`. A receipt line is
  therefore identified by receipt and line everywhere, not by `lineId` alone.
- An `nfeProc` must hold exactly `NFe` and `protNFe`. Content beside the signed note
  is refused, because the XSD only covers the `NFe`.
- The reconciliation request gained optional `unitFactors`, so a reviewer can
  confirm the buyer units per supplier unit. The factor is remembered with the mapping.
- `fiscal.inbound.matched` carries a null `accessKey` when the issuer is a natural
  person, because the key embeds a CPF.
- `payableTitleIds` is a snapshot of the posted payables Fiscal knew at commit. It can
  be empty when Financial's post had not reached Fiscal yet.
- A return for a receipt Fiscal never projected (recorded before Phase 44) is ignored
  rather than dead-lettered.
- The supplier NF-e fixture builder moved to `src/nfe55/supplier-invoice.ts`. The
  `phase44:supplier-invoice` CLI exposes it for simulation drills, gated by
  `FISCAL_ALLOW_SUPPLIER_FIXTURE=true`.

## Exit evidence (from the roadmap)

- Reimporting the same XML and replaying the Procurement/Financial events create no
  second receipt, payable or reconciliation. Fiscal's outbox holds exactly one
  `fiscal.inbound.matched`. In the local stack, Financial still has exactly one payable
  for the receipt.
- A partially received order matches one of several invoices. Receipts R1 and R2 of the
  same order reconcile with invoices A and B. A third invoice that claims R1's quantity
  again cannot be allocated.
- An XML that arrives before its receipt stays open and is proposed once the receipt is
  projected. An XML that arrives after its receipt is proposed immediately. Both keep
  the reconciliation decision.
- Two tenants with the same supplier CNPJ never see each other's XML, index rows,
  proposals or reconciliations.
- A conflicting duplicate is visible on the original import and blocks its
  reconciliation until it is dismissed with a reason.

## Non-goals

- Querying SEFAZ (NF-e distribution or protocol consultation) for inbound status, and
  ICP-Brasil chain validation. Both are capabilities with their own evidence.
- Creating receipts, payables or stock from XML, or consuming `fiscal.inbound.matched`
  in Procurement or Financial.
- Return, complementary and adjustment invoices (Phase 45), CT-e, and inbound NFS-e.
- Undoing a committed reconciliation, and the operator screens (Phase 48).
