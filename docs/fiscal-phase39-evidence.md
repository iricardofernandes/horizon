# Phase 39 verification record

This record checks the Phase 39 work and exit evidence against the implementation
plan. It concerns the unsupported-by-default ingress path; it does not authorize any
document model, adapter or jurisdiction.

| Requirement | Implementation evidence | Verification |
|---|---|---|
| Ownership, dispatch, unknown authority outcome, legacy migration and separate model diagrams | [ADR 0048](adr/0048-fiscal-origin-and-operational-ownership.md), [migration runbook](fiscal-phase39-migration.md) | Review the owner table and the three state diagrams before enabling an operation. |
| Source register and default-unsupported capability matrix | [Source register](fiscal-source-register.md), [capability matrix](fiscal-capabilities.md) | Official MOC, NT, XSD and NFS-e artifacts have dated SHA-256 entries; no capability row is enabled. |
| Numeric and alphanumeric CNPJ through owner and legacy paths | Parties, Identity and Sales value objects, encrypted indexes and expanded persistence; web party classifier | Parties, Identity and Sales database suites round-trip the new format; Sales also round-trips a numeric legacy identifier. Web unit test covers both kinds. |
| Effective-dated issuer, recipient and classification revisions | Identity, Parties and Catalog owner migrations, contracts and restricted HTTP exports | Owner database suites check versions, event payloads, encryption and tenant scope; restricted role tests reject ordinary readers. |
| Secure owner-API backfill and erasure | Fiscal inbox, projections, backfill, service token exchange and [ADR 0049](adr/0049-restricted-fiscal-profile-projections.md) | Fiscal PostgreSQL/RabbitMQ suite checks duplicate delivery, retry, backfill resume, count/digest reconciliation, erasure and cross-tenant RLS. Identity HTTP suite exchanges a real service key for a restricted token and rejects another tenant. |
| One Sales fiscal origin per billable shipment or return | Sales origin key and outbox; Fiscal intent key | Sales database suite checks two partial deliveries and one full return emit three contract-valid origins. Fiscal suite checks two event IDs for one origin result in one blocked intent. |

The Phase 39 golden path ends at a `blocked_profile` intent because every capability
is `unsupported`. Stock and receivable effects remain attached to the Sales dispatch
or return; [ADR 0048](adr/0048-fiscal-origin-and-operational-ownership.md) names the
owner of every effect. Authority authorization, tax calculation and document artifacts
are later-phase work and require their own evidence.

## Local Docker rollout, 2026-09-21

The additive owner and Fiscal migrations were applied to the local Compose stack. A
tenant created for this validation supplied its own service key. The deployed backfill
reported matching source, checkpoint and projection counts of **1/1/1** for Identity,
Parties and Catalog. A recipient profile change then crossed RabbitMQ and appeared as
revision 2 in Fiscal; a second backfill reported **2/2/2** for Parties and **1/1/1**
for the other owners. Each run also reported matching rolling digests.

Final reconciliation retained from the deployed backfill:

| Owner | Observed | Checkpoint | Projected | Rolling digest |
|---|---:|---:|---:|---|
| Parties | 2 | 2 | 2 | `7be8049a2be6a665064f4a6e6bf56fa3656bff1c79c77ff1c04ba3aa4192fbe1` |
| Identity | 1 | 1 | 1 | `6d4f2841242e83d593ea900c43fdc933b8bed5950b04359de7c91fa4b926dc96` |
| Catalog | 1 | 1 | 1 | `34ad96941a16e7dfec392bbe5fa6c4217f00dfee24dc61c6a86d1df187c542f4` |

The same tenant completed the API path from price and stock receipt through Sales
order, reservation, picking, packing and dispatch. Sales wrote one
`sales.fiscal-origin.recorded` outbox event for shipment
`01a0c5fd-abbe-774b-bdba-b9dc3c807d9e`; Fiscal consumed it and persisted exactly
one intent with status `blocked_profile`. The preexisting tenant retained its 18 Sales
orders; the validation tenant added one. Fiscal's broker queue was empty after
consumption. Database suites cover duplicate event IDs for the same origin and
cross-tenant isolation.

The first attempt exposed a preexisting Inventory onboarding gap: its first warehouse
required a tenant row in Inventory. The warehouse command now provisions that row.
An integration test and a second fresh tenant on the deployed stack confirmed a row
count of 0 before the API call and 1 afterward. The installed Inventory image was also
rebuilt to match its already-migrated database schema.

Fiscal's dead-letter queue had 16 historical messages, including unrelated module
events, because it was bound to the shared dead-letter exchange with `#`. Its binding
now names only the five Fiscal event types; the deployed RabbitMQ bindings and an
integration test confirm that unrelated events no longer enter this queue. The 16
historical messages remain for operator review rather than being discarded.
Inspection of their envelopes showed only the two local validation tenants; none
belonged to the preexisting tenant. The two Fiscal-relevant envelopes are already
represented by the reconciled party revision and the single persisted origin intent.

## Operational gate

Before using another tenant's live data, provision that tenant's fiscal service key,
run the owner API backfill and retain its count/digest reconciliation output. Review
broker dead-letter entries and backup-key lifecycle. This local rollout validates the
isolated tenant above; each future target environment needs its own reconciliation.
Keep every capability `unsupported` until an exact model and jurisdiction has reviewed
sources, fixtures and homologation evidence.
