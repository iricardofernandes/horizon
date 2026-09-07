# 13. Vitest, with Testcontainers for integration and e2e

- Status: accepted
- Date: 2026-09-07

## Context

Horizon's most important correctness claims are enforced by PostgreSQL, not by
application code: Row-Level Security policies, a forced-RLS application role that
lacks `BYPASSRLS`, `REVOKE UPDATE, DELETE` on the audit table, and an append-only
trigger. None of those can be tested against a mock, an in-memory database, or a
schema-per-run trick on a shared instance — the last of these cannot create or grant
roles independently per run, and role configuration is precisely what is under test.

The usual workaround — a randomly-named schema per run inside a Postgres started by a
shared compose file — does not reach the guarantees under test. Roles, grants and
`FORCE ROW LEVEL SECURITY` are cluster- and table-scoped, not schema-scoped, so every
concurrent run would share one role configuration. It also leaks schemas whenever a run
is killed, and it makes the suite depend on an externally-managed service being up.

## Decision

**Vitest** with `globals: true` in every project.

- Unit tests: `*.spec.ts`, colocated with the code, no I/O, in-memory repository fakes
  (ADR 0014). These are the tests the coverage gate applies to.
- Integration and e2e: `*.e2e-spec.ts` under `test/`, run by a second config
  (`vitest.config.e2e.ts`), against **real PostgreSQL, Redis and RabbitMQ started by
  Testcontainers** — not against a shared compose instance.

Each e2e run gets its own containers, its own cluster, its own roles, and its own
migrations, and everything dies with the process.

## Consequences

- Runs are hermetic and parallelizable. Two suites cannot interfere, and a killed run
  leaks nothing.
- RLS is testable end to end: a test can create the application role without
  `BYPASSRLS`, connect as it, and assert that tenant B sees nothing tenant A wrote.
  This is the decisive advantage and the reason for the decision.
- CI needs no service containers declared per job; the test process starts what it
  needs. The job needs a Docker socket.
- Container startup costs seconds per suite. Mitigated by grouping e2e specs so
  containers are reused within a suite, and by keeping the fast unit suite as the
  `pre-push` hook's gate — e2e runs in CI.
- Testcontainers is a dev dependency in every service module. Ten copies; accepted per
  ADR 0001.

## Alternatives considered

**Schema-per-run against a shared compose Postgres.** Rejected: cannot test role-level
guarantees, leaks on abort, couples the test suite to an externally-managed service
being up.

**An embedded or in-memory PostgreSQL (pglite, pg-mem).** Rejected: neither implements
RLS and role privileges faithfully enough for the guarantees under test, and a test
that passes against a partial implementation is worse than no test.

**Mocking the repository at the integration level.** Rejected — that is what the unit
tests already do, and it proves nothing about the database.

**Jest.** Rejected: Vitest is faster, needs no transform configuration beyond the SWC
plugin Nest requires, and shares the Vite config used by `web/`.
