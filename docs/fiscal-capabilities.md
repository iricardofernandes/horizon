# Fiscal capability matrix

The key is `(model, environment, issuer establishment, jurisdiction, operation,
adapter version)`. `unsupported` is the default even when a row is absent. A row can
advance to `simulated` with deterministic fixtures, to `homologated` with authority
test evidence and to `production-enabled` only with the exact production configuration
and release approval. An issuer, UF or municipality never inherits another's status.

| Model | Environment | Issuer | Jurisdiction | Operation | Adapter | State | Evidence | Evidence date |
|---|---|---|---|---|---|---|---|---|
| NF-e 55 | simulation | one locally configured establishment | SP | normal-sale | `nfe55-simulator-v1` | simulated locally | [Phase 42 evidence](fiscal-phase42-evidence.md) | 2026-09-22; re-verified 2026-09-26 (Phase 48 golden path and restore) |
| NF-e 55 | homologation (emulated authorizer) | per tenant establishment with its own A1 | issuer's UF (SP and RJ exercised) | normal-sale issue/query/cancel | `nfe55-<authorizer>-homologation-v1` | drill only, never activated | [Phase 43 simulation evidence](fiscal-phase43-evidence.md#ensaio-emulado-multi-uf-2026-09-26) | 2026-09-26 |
| NF-e 55 | homologation (official authorizer) | none configured | no UF configured | issue/query/cancel | none | unsupported | none | — |
| NF-e 55 | production | none configured | no UF configured | issue/query/cancel | none | unsupported | none | — |
| NF-e 55 | simulation | one locally configured establishment | SP | sale-return, purchase-return, value-complement (`finNFe` 4/2 with `NFref`) | `nfe55-simulator-v1` | simulated locally | [Phase 45 evidence](fiscal-phase45-evidence.md) | 2026-09-26 |
| NF-e 55 | simulation | any authorized simulated NF-e | SP | correction letter (event 110110) | `nfe55-simulator-v1` | simulated locally | [Phase 45 evidence](fiscal-phase45-evidence.md) | 2026-09-26 |
| NF-e 55 | any | none configured | any | remittance, adjustment, quantity/tax complement, credit/debit note | none | unsupported (no owner fact or reviewed rule) | [ADR 0052](adr/0052-returns-and-complements-are-linked-documents.md) | — |
| NF-e 55 inbound (supplier XML) | any `tpAmb` (kept on the import) | tenant as recipient | any issuer UF | import, verify signature, reconcile with receipts | `nfe55/inbound.ts` (PL 010f) | simulated locally; authority status and ICP-Brasil chain unverified | [Phase 44 evidence](fiscal-phase44-evidence.md) | 2026-09-26 |
| NFC-e 65 | simulation | one locally configured establishment | SP | consumer-sale (Sales shipment to a final, non-contributor consumer; QR code v3 online; cancellation 110111 inside the reviewed window) | `nfce65-simulator-v1` | simulated locally | [Phase 46 evidence](fiscal-phase46-evidence.md) | 2026-09-26; artifacts re-verified by the Phase 48 restore |
| NFC-e 65 | any | none configured | any | counter (cashier) sale, offline contingency (`tpEmis` 9), EPEC, correction letter, return or complement of an NFC-e | none | unsupported | [ADR 0053](adr/0053-nfce-is-a-separate-model-over-the-sales-shipment.md) | — |
| NFC-e 65 | homologation | none configured | no UF configured | issue/query/cancel | none | unsupported | none | — |
| NFC-e 65 | production | none configured | no UF configured | issue/query/cancel | none | unsupported | none | — |
| National NFS-e | simulation | one locally configured establishment | São Paulo (IBGE 3550308), routed by the reviewed registry version of the 2026-09-18 adhesion list | service-provision (DPS layout 1.01, query by DPS and key, cancellation 101101 inside the municipal window, substitution 105102) | `nfse-national-simulator-v1` | simulated locally | [Phase 47 evidence](fiscal-phase47-evidence.md) | 2026-09-26; artifacts re-verified by the Phase 48 restore |
| National NFS-e | any | none configured | municipalities with their own issuing system (for example Campinas 3509502: agreement active, national issuer "Não") or absent from the reviewed registry | any | none | unsupported (needs its own adapter and support row) | [ADR 0054](adr/0054-national-nfse-is-keyed-by-municipality-and-reconciled-by-dps.md) | — |
| National NFS-e | any | none configured | any | Simples Nacional or MEI provider, withholding, deductions, benefits, export, tomador or intermediary issuance, manifestation and fiscal-analysis events | none | unsupported | [ADR 0054](adr/0054-national-nfse-is-keyed-by-municipality-and-reconciled-by-dps.md) | — |
| National NFS-e | restricted production | none configured | no municipality configured | issue/query/cancel | none | unsupported | none | — |
| National NFS-e | production | none configured | no municipality configured | issue/query/cancel | none | unsupported | none | — |

The evidence date is the day the row's evidence was produced on the local stack. No row is
enabled in homologation or production, so no homologation suite runs as part of the
release gate; the Phase 48 evidence records that the set of enabled homologation rows is
empty.

The Fiscal support page (`/app/fiscal/support`) shows, per tenant, the tuples activated
for that workspace; this table is the release-level view.

This matrix is configuration and release evidence, not a guess from a service URL.
The Fiscal read API returns `unsupported` by default and exposes only the locally
activated Phase 42 simulation tuple; the model 65 tuple is read from the version 2 kind
catalogue, and the NFS-e tuple from the registry resolution and `/fiscal/service-documents`. Supplier XML import verifies the signed bytes but never
claims authority status ([ADR 0051](adr/0051-supplier-xml-is-evidence-not-an-operational-fact.md)). An emulated drill cannot activate a homologation
row ([ADR 0050](adr/0050-fiscal-authorizer-follows-issuer-jurisdiction.md)). Homologation and production routes remain
disabled. Source artifacts and checksums are tracked in
[fiscal-source-register.md](fiscal-source-register.md).
