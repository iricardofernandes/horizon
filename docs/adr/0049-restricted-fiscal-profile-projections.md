# 49. Restricted fiscal profile projections

- Status: accepted and implemented locally; deployment reconciliation pending
- Date: 2026-09-21

## Context

Fiscal needs the issuer's legal profile and the recipient's full CPF/CNPJ, registration,
taxpayer indicator and structured address. Current `parties.party.registered/updated`
events omit tax identifiers deliberately, and a shared durable RabbitMQ/outbox payload
with full personal data would make erasure unreliable (ADR 0026). The existing Parties
`read` permission is also too broad for exporting full identifiers to a new consumer.
Identity has no company-profile event, and old recipient addresses are free text.

## Decision

Parties and Identity remain the owners of mutable fiscal profile data. They emit a
versioned **change notice** with tenant id in the envelope, aggregate id, profile
revision and effective date. No full identifier, address, name, certificate or contact
data appears in the outbox event, broker headers or logs. A Fiscal projector consumes
the notice and retrieves the matching revision asynchronously through a dedicated
tenant-scoped, service-authenticated export endpoint. This is not an HTTP call in the
document write path. A missing projection leaves the draft blocked for operator review.

The export endpoint requires the dedicated `fiscal-reader` role in each owner,
not a human's ordinary `parties:read` or `identity:read` role. It returns only the fields
needed for the named issuer or recipient operation. Fiscal encrypts the copy under its
own subject key, indexes a tax identifier only by a keyed blind index if lookup needs
it, and records source revision and effective interval. The projection retains previous
revisions required by immutable issued-document snapshots; mutable drafts always use a
specified revision. Erasure notices destroy mutable personal copies and keys in Fiscal;
retention of a legally required issued artifact is handled separately by the approved
retention policy, never by silently keeping a general-purpose projection alive.

Backfill uses paginated, authorized owner APIs and resumes from a stable cursor. It
does not read the owner's tables or replay decrypted data through the general event
bus. No event or backfill job can claim completion until counts, checksums and a
cross-tenant negative test agree. Existing free-text addresses and issuer profiles
without IBGE municipality codes are marked incomplete; no code guesses the municipality
or tax classification from the city name.

The Identity service exchanges a tenant-scoped, rotatable API key with restricted read
scopes for a short token containing only the two `fiscal-reader` assignments and a
Catalog read assignment. Fiscal refreshes the token before expiry and validates the
tenant in every owner response before storing it.

The contracts release must add change notices and the dedicated role before either
producer emits them. Then deploy projectors, run backfill, verify lag and compare source
revisions, and finally enable fiscal draft creation. Every consumer pins the released
contract version under ADR 0029/0030. The credential is rotated and scoped to one
tenant; no API response or trace includes a full profile.

## Consequences

- No general subscriber can obtain a full tax identifier from an event.
- Projection lag is explicit and blocks issuance instead of triggering a synchronous
  dependency or using stale data unnoticed.
- Existing Parties and Identity rows need expand/backfill migrations for structured
  profiles and effective intervals before the export can be considered complete.
- The service credential exchange, owner endpoints, encrypted projection, erasure and
  cross-tenant tests are implemented. Deployment still requires credential provisioning,
  backup-key lifecycle review and owner/checkpoint reconciliation for each tenant before
  an authority capability can be enabled.
