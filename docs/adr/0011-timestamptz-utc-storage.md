# 11. `timestamptz`, UTC in storage, tenant timezone at presentation

- Status: accepted
- Date: 2026-09-07

## Context

Horizon is multi-tenant. Tenants are in different timezones, and Brazil alone spans
several — and abolished daylight saving time in 2019, which means historical
timestamps in the same tenant may or may not fall in a DST period depending on their
date. An audit hash chain (ADR 0025) and event ordering both depend on timestamps
being comparable across modules.

PostgreSQL's `timestamp without time zone` stores a wall-clock reading with no
information about which clock. Two rows written a second apart from different
containers can compare in the wrong order, and no amount of care at the application
layer recovers the lost information.

## Decision

Every temporal column is **`timestamptz`**. All timestamps are **stored and compared
in UTC**. The tenant's timezone is applied **only at presentation** — in HTTP
responses that are explicitly local, in the frontend, and in exported documents.

Tenant timezone is a property of the tenant, resolved from the request context, never
inferred from the server or the client.

Date-only business values — a due date, a fiscal competence period — are `date`, not a
timestamp, because they are not instants and converting them through a timezone
corrupts them.

## Consequences

- Cross-module event ordering is meaningful: `occurredAt` from `sales/` and
  `receivedAt` in `inventory/` are on the same clock.
- The audit hash chain's canonical JSON serialises timestamps in a single unambiguous
  form, so a chain verified on one machine verifies identically on another.
- Every presentation path must decide a timezone explicitly. There is no implicit
  local formatting; a formatter that is not given a timezone is a bug.
- The `date`/`timestamptz` distinction must be made per column at design time. Getting
  it wrong in the other direction — a due date stored as an instant — produces
  off-by-one-day errors that appear only for tenants west of UTC.

## Alternatives considered

**`timestamp without time zone` with a convention that everything is UTC.** Works
until one code path forgets. Rejected: the convention is unenforceable and the failure
is silent.

**Storing local time plus a timezone column.** Preserves the original wall clock,
which matters for future scheduled events across DST boundaries. Rejected as
unnecessary for the current scope; if a scheduling feature ever needs it, it will
store the local time and zone *in addition to*, never instead of, the UTC instant.
