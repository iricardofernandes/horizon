# 51. A supplier NF-e is evidence, not an operational fact

- Status: accepted and implemented locally; exercised in simulation
- Date: 2026-09-26

## Context

Phase 44 imports the NF-e a supplier issues to the tenant and compares it with what was
bought and received. Procurement already owns the order and the goods receipt.
`procurement.receipt.recorded` already moves stock in Inventory and raises the payable
in Financial. Letting an XML also create stock or a payable would count the same
delivery twice. An XML also arrives on its own schedule: before the goods, after
them, twice, or as a forged copy under the same access key.

Party tax ids stay encrypted in Fiscal (ADR 0049), yet Fiscal must find the supplier
by the CNPJ in the XML. An NF-e can also name a natural person (a CPF issuer), and its
access key then embeds that CPF.

## Decision

An imported NF-e is **evidence**:
- Fiscal verifies it and keeps the original bytes encrypted.
- Fiscal compares it with read-only projections of Procurement's order and receipt
  lines and of Financial's posted payables for `purchase-receipt` origins.
- Fiscal never writes to those modules. Only a reviewer's committed reconciliation
  publishes `fiscal.inbound.matched`, and no module consumes it for stock or money.

Trust comes from the signed bytes:
- The signature must reference `#NFe<key>` and verify with the certificate in
  `KeyInfo`.
- That certificate's ICP-Brasil CNPJ root must be the issuer's.
- Every staged field is parsed from the canonical `infNFe` that the signature
  authenticated.
- An `nfeProc` must hold exactly the `NFe` and a protocol that authorizes that key and
  that `DigestValue`.

The chain to an ICP-Brasil root and the authority's current status are not verified yet.
Each import records `signature: valid-unanchored` and `authorityStatus: unverified`.

Identity is the access key per tenant:
- An upload with the same signed content is a duplicate.
- Other signed content under the same key is a conflict. It is kept, shown on the
  original import, and blocks reconciliation until a reviewer dismisses it with a
  reason. A database trigger enforces this too.

A reconciliation links invoice lines to receipt lines by stable ids (the receipt and
the order line it received). Amounts and dates only rank proposals:
- Allocations across all reconciliations never exceed what arrived minus what was
  returned. The service checks this under row locks, and a trigger checks it again.
- Any quantity, value, item or unmatched-line difference is kept only as `overridden`,
  with a reason and the original comparison.
- A later return or payable reversal is shown next to the decision and never rewrites
  it.

Supplier lookup uses a blind index:
`HMAC(HKDF(master, tenant, 'fiscal-party-tax-index-v1'), taxId)`. The same CNPJ gives
unrelated digests in two tenants, and erasing a Party deletes its row. The parsed
invoice is sealed with a tenant key. The event omits the access key when the issuer is
a natural person.

## Consequences

- Reimporting, replaying the broker and retrying the commit are all no-ops. The local
  stack showed one receipt, one payable and one stock movement after all three.
- Receipts recorded before Fiscal followed Procurement are not projected. Matching an
  invoice against them needs a replay of Procurement's facts. A return for such a
  receipt is ignored rather than dead-lettered.
- A supplier unit differs from the buyer's unit until a reviewer confirms a factor. The
  factor is remembered per `(supplier, cProd)` as an append-only mapping.
- An imported NF-e is fiscal evidence the tenant must keep. Erasing a supplier Party
  removes its index row, but not the retained XML.
- Querying the authority for inbound status (distribution or consultation) and
  ICP-Brasil chain validation are later capabilities with their own evidence. Until
  then the import says it is unverified.
