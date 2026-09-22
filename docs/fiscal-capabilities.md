# Fiscal capability matrix

The key is `(model, environment, issuer establishment, jurisdiction, operation,
adapter version)`. `unsupported` is the default even when a row is absent. A row can
advance to `simulated` with deterministic fixtures, to `homologated` with authority
test evidence and to `production-enabled` only with the exact production configuration
and release approval. An issuer, UF or municipality never inherits another's status.

| Model | Environment | Issuer | Jurisdiction | Operation | Adapter | State | Evidence |
|---|---|---|---|---|---|---|---|
| NF-e 55 | homologation | none configured | no UF configured | issue/query/cancel | none | unsupported | none |
| NF-e 55 | production | none configured | no UF configured | issue/query/cancel | none | unsupported | none |
| NFC-e 65 | homologation | none configured | no UF configured | issue/query/cancel | none | unsupported | none |
| NFC-e 65 | production | none configured | no UF configured | issue/query/cancel | none | unsupported | none |
| National NFS-e | restricted production | none configured | no municipality configured | issue/query/cancel | none | unsupported | none |
| National NFS-e | production | none configured | no municipality configured | issue/query/cancel | none | unsupported | none |

This matrix is configuration and release evidence, not a guess from a service URL.
The Phase 40 read API returns `unsupported` by default and no supported rows. Its
transmission and cancellation routes reject every tuple. Source
artifacts and checksums are tracked in [fiscal-source-register.md](fiscal-source-register.md).
