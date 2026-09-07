# 28. `Idempotency-Key` on public write endpoints

- Status: accepted
- Date: 2026-09-07

## Context

A client sends `POST /orders`, the order is created, and the response is lost to a
network failure. The client has no way to know whether the order exists. If it retries,
it may create a second order; if it does not, it may have lost a legitimate one.

This is unavoidable at the protocol level — the client cannot distinguish "request
never arrived" from "response never returned" — so the server must provide the
mechanism that makes retrying safe. ADR 0027 permits retrying non-idempotent writes
only with an idempotency key; this ADR defines it.

## Decision

**Public write endpoints accept an `Idempotency-Key` header.**

- The server stores a **fingerprint of the response** in Redis, keyed by
  `(tenant, endpoint, idempotency key)`, with a **24-hour TTL**.
- Replaying a key returns the **original response** — same status, same body — without
  re-executing the operation.
- A key replayed with a **different request body** is a client error, not a cache hit.
  It returns a conflict, because it means the client reused a key for a different
  operation and silently returning the first response would be wrong.
- A key seen while its first request is **still in flight** returns a conflict rather
  than waiting or duplicating.

The key is client-generated and opaque; the server does not parse it.

## Consequences

- A client can retry any write safely, which is what makes ADR 0027's retry policy
  applicable to writes at all.
- 24 hours is chosen to comfortably exceed any reasonable client retry window while
  bounding storage. It is configuration, not a constant.
- Redis holds the record, so an outage means an unrecognised key and therefore a
  duplicate execution. The window is small and the failure is toward duplication rather
  than loss; where duplication is unacceptable, the domain adds its own natural key —
  an order carries a client reference that is unique per tenant, so a duplicate fails
  on a database constraint even if the idempotency layer missed it. Belt and braces,
  because the idempotency layer is a convenience and the constraint is a guarantee.
- The header is optional. Making it mandatory would break clients that do not know
  about it; the documentation states plainly that a write sent without one is not
  safe to retry.
- This is a different mechanism from the inbox (ADR 0024), and the distinction matters:
  the inbox deduplicates *events between modules* by event id, the idempotency key
  deduplicates *HTTP requests from clients*. Both exist; neither replaces the other.

## Alternatives considered

**Natural idempotency by resource-defined identity** — the client supplies the id, so
`PUT /orders/{id}` is naturally idempotent. Cleaner where it fits, and used where it
fits. Rejected as the general answer: many operations are genuinely creational or
transition an aggregate, and forcing every one into a client-chosen identity distorts
the API.

**Server-side deduplication on a content hash.** Rejected: two genuinely distinct
orders with identical contents are legitimate, and the server cannot tell them apart.

**No mechanism; tell clients not to retry.** Rejected: clients retry regardless, and the
mechanism's absence just moves the duplicate into the database.
