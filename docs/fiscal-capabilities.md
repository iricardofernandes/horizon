# Fiscal capability matrix

The key is `(model, environment, issuer establishment, jurisdiction, operation,
adapter version)`. `unsupported` is the default even when a row is absent. A row can
advance to `simulated` with deterministic fixtures, to `homologated` with authority
test evidence and to `production-enabled` only with the exact production configuration
and release approval. An issuer, UF or municipality never inherits another's status.

| Model | Environment | Issuer | Jurisdiction | Operation | Adapter | State | Evidence |
|---|---|---|---|---|---|---|---|
| NF-e 55 | simulation | one locally configured establishment | SP | normal-sale | `nfe55-simulator-v1` | simulated locally | [Phase 42 evidence](fiscal-phase42-evidence.md) |
| NF-e 55 | homologation (emulated authorizer) | per tenant establishment with its own A1 | issuer's UF (SP and RJ exercised) | normal-sale issue/query/cancel | `nfe55-<authorizer>-homologation-v1` | drill only, never activated | [Phase 43 simulation evidence](fiscal-phase43-evidence.md#ensaio-emulado-multi-uf-2026-09-26) |
| NF-e 55 | homologation (official authorizer) | none configured | no UF configured | issue/query/cancel | none | unsupported | none |
| NF-e 55 | production | none configured | no UF configured | issue/query/cancel | none | unsupported | none |
| NFC-e 65 | homologation | none configured | no UF configured | issue/query/cancel | none | unsupported | none |
| NFC-e 65 | production | none configured | no UF configured | issue/query/cancel | none | unsupported | none |
| National NFS-e | restricted production | none configured | no municipality configured | issue/query/cancel | none | unsupported | none |
| National NFS-e | production | none configured | no municipality configured | issue/query/cancel | none | unsupported | none |

This matrix is configuration and release evidence, not a guess from a service URL.
The Fiscal read API returns `unsupported` by default and exposes only the locally
activated Phase 42 simulation tuple. An emulated drill cannot activate a homologation
row ([ADR 0050](adr/0050-fiscal-authorizer-follows-issuer-jurisdiction.md)). Homologation and production routes remain
disabled. Source artifacts and checksums are tracked in
[fiscal-source-register.md](fiscal-source-register.md).
