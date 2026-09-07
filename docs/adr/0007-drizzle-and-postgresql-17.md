# 7. Drizzle and PostgreSQL 17

- Status: accepted
- Date: 2026-09-07

## Context

Horizon's tenant isolation is enforced by PostgreSQL Row-Level Security, and RLS
requires that every transaction issue `SET LOCAL app.current_tenant = $1` before any
statement, on the same connection, inside the same transaction (ADR 0017). The ORM
choice is therefore subordinate to a database requirement, not a matter of ergonomics.

## Decision

**Drizzle ORM** over **PostgreSQL 17** (`postgres:17-alpine`).

Drizzle's transaction API hands the callback a transaction handle bound to one
connection, so `SET LOCAL` composes naturally and every subsequent statement in the
callback is guaranteed to run on the same session. Schema is defined in TypeScript
and migrations are generated to plain SQL files, which is essential here: RLS
policies, the append-only audit trigger, the `REVOKE` statements and the role grants
are hand-written SQL that lives in the same migration sequence as the table
definitions.

## Consequences

- Migrations are readable SQL under version control, and the security-relevant ones
  are reviewable as SQL rather than as ORM configuration.
- Drizzle produces no client generation step and no runtime engine binary, which
  keeps the multi-stage Docker build small and Alpine-friendly.
- Drizzle's query builder is closer to SQL than a Prisma-style client, so the
  "one dot per line" calisthenics rule is relaxed for it (ADR 0031).
- Row types are inferred from the schema, so mappers convert between a Drizzle row
  type and a domain aggregate — the same pattern as the reference's Prisma mappers.
- Less mature ecosystem than Prisma: fewer generated helpers, more hand-written
  queries. Accepted.

## Alternatives considered

**Prisma.** Better DX, better tooling, larger ecosystem. Rejected on the decisive
point: Prisma's client offers no supported way to run `SET LOCAL` on the same
connection that will serve the subsequent queries in a transaction without dropping
to `$executeRawUnsafe` inside `$transaction`, and even then the guarantee rests on
implementation detail. Building the project's central isolation mechanism on an
undocumented behaviour is not acceptable.

**Kysely.** Excellent type-safe query builder with full control over connections.
Rejected narrowly: no built-in migration generation from a schema definition, so the
schema would live twice.

**Raw `pg` with hand-written SQL.** Maximum control. Rejected: the mapper boundary
already isolates the domain from persistence, and hand-writing every query adds
volume without adding demonstrated skill.
