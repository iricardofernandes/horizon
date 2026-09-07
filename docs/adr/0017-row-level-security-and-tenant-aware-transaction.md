# 17. Row-Level Security, and the `TenantAwareTransaction`

- Status: accepted
- Date: 2026-09-07

## Context

Multi-tenant isolation implemented as `WHERE tenant_id = $1` in application code is a
guarantee that must be re-established in every query, forever, by every author. It
fails silently: the query returns rows, the test passes, and the leak is discovered by
a customer. There is no way to audit it except by reading every query.

The layered-architecture default makes it worse rather than better. A repository reads
by id, and the ownership check happens afterwards, in the use case — by which point the
row has already crossed the boundary. That ordering is correct for *authorization*,
where the question is whether this actor may act on a row that legitimately exists. It
is wrong for *isolation*, where the row must never be readable at all.

## Decision

Isolation is enforced by PostgreSQL, and made structurally unavoidable in TypeScript.

**In the database:**

- `tenant_id uuid not null` on every business table.
- Row-Level Security **enabled and forced** (`ENABLE` plus `FORCE`), so the policy
  applies even to the table's owner.
- Policies compare `tenant_id` to `current_setting('app.current_tenant')::uuid`.
- The application role holds neither `SUPERUSER` nor `BYPASSRLS`. Migrations run under
  a separate owner role that the application never uses.
- Composite indexes always lead with `tenant_id`.

**In the application:**

- Every request opens a transaction and issues `SET LOCAL app.current_tenant = $1`
  before any other statement. `SET LOCAL` is transaction-scoped, so a pooled
  connection cannot carry a tenant into the next request.
- A single `TenantAwareTransaction` abstraction owns this. **No repository may obtain
  a raw connection**, and this is made structurally impossible rather than
  conventionally discouraged: the Drizzle client is not exported from the module that
  constructs it. Only the transaction runner is exported. A repository has no
  reachable path to an unscoped connection.
- Tenant context is derived from the validated JWT or API key by an interceptor and
  propagated through `AsyncLocalStorage`. A request with no resolvable tenant is
  rejected before reaching any handler.

**In the tests:** every test creates its own tenant, and every aggregate has a test
that writes under tenant A and asserts tenant B cannot read it (ADR 0014).

## Consequences

- A forgotten `WHERE tenant_id` clause returns nothing rather than returning another
  tenant's data. The failure mode inverts from silent leak to loud emptiness.
- If `app.current_tenant` is unset, `current_setting` raises and every query fails.
  This is deliberate: no tenant context means no data, never all data.
- A modest per-transaction cost (`SET LOCAL`) and a policy evaluation per row. Kept
  cheap by the tenant-leading composite indexes.
- Cross-tenant administrative operations — a platform-wide migration, a support tool —
  need a distinct role and a distinct, audited code path. There is no "admin bypass"
  in the application role.
- Background workers (the outbox relay, the webhook dispatcher) process rows for many
  tenants. They set the tenant per unit of work, never process a batch under one
  context.

## Alternatives considered

**Application-level filtering only.** Rejected as described in Context.

**A database per tenant.** The strongest isolation available. Rejected: it does not
scale operationally past a few dozen tenants — every migration multiplies, and
connection pooling becomes the dominant problem — and an ERP aims at many small
tenants.

**A schema per tenant.** Same objection, slightly cheaper.

**RLS without `FORCE`.** Rejected: without `FORCE`, the table owner bypasses the
policy, and any accidental use of the owner role silently disables the entire
mechanism.
