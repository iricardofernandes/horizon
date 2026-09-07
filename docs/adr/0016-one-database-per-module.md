# 16. One database per module

- Status: accepted
- Date: 2026-09-07

## Context

Five services that share a database are not five services. A shared schema means a
migration in one module can break another, a slow query in one exhausts the
connections of all, and any team can read — and eventually write — another's tables.
The boundary that ADR 0001 and ADR 0002 enforce in source would be undone in
persistence.

## Decision

**One PostgreSQL database per module.** In local development a single container hosts
N databases; in the Terraform definition, one RDS instance per module. Module code
never sees the difference, because it holds a connection string and nothing else.

There is no cross-module join, no shared table, no foreign key across a module
boundary, and no read access to another module's database — not even read-only, not
even for reporting.

Data another module needs arrives one of two ways: a synchronous HTTP call through
Kong, or a local projection maintained from that module's published events.

## Consequences

- Referential integrity across contexts is not enforced by the database. `sales/`
  holds a `product_id` that `catalog/` owns, and nothing prevents it pointing at a
  deleted product. This is handled by making deletions soft and event-driven, and by
  each module validating references at the point of use — the standard cost of the
  pattern, paid deliberately.
- Writing to two modules is not atomic. This is exactly why the transactional outbox
  (ADR 0024) is mandatory rather than optional.
- Migrations are per-module and independently deployable, which is what makes
  expand/contract migrations meaningful (`docs/patterns/zero-downtime-migration.md`).
- Reporting across modules requires a consumer that builds a read model from events.
  None is built in the current scope; a future one is a module, not a query.
- Five connection pools, five backup concerns, five sets of credentials.

## Alternatives considered

**One database, schema per module, with per-module roles.** Materially cheaper and
gives most of the isolation. Rejected on two grounds: a cross-schema join is one
`SET search_path` away, so the boundary is again a convention; and a shared cluster
shares connection limits, autovacuum pressure and failure domain, which means the
services are not independently deployable in the sense the architecture claims.

**One database, one schema, module-prefixed tables.** Rejected outright.

**A database per module, but a shared read replica for reporting.** Rejected for now:
it recreates the coupling through a side door, and the reporting requirement does not
yet exist.
