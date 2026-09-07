# 14. Test factories and in-memory repositories

- Status: accepted
- Date: 2026-09-07

## Context

Two problems recur in tests of a layered system. First, constructing a valid aggregate
in a test requires filling every required field, so tests accumulate irrelevant setup
that obscures what is actually being asserted — and when the aggregate gains a field,
every test breaks. Second, testing a use case against a real database makes the unit
suite slow enough that it stops being run, and testing it against a mocking framework
produces tests that assert on call shapes rather than on behaviour.

The reference project solves both, and the solution is adopted with one addition.

## Decision

**Factories.** For every aggregate, `test/factories/make-<aggregate>.ts` exports:

- `make<Aggregate>(override?, id?)` — a pure builder returning a valid domain object
  with faker-generated defaults, every field overridable;
- `class <Aggregate>Factory` — an injectable that builds the same object and persists
  it through the **same mapper the production repository uses**, for e2e tests.

The two halves share their defaults, so the unit suite and the e2e suite cannot drift
on what a valid aggregate looks like, and persistence goes through the mapper so a
mapper bug fails the e2e setup rather than hiding inside it.

**In-memory repositories.** Every repository interface has an in-memory
implementation under `test/repositories/`, implementing the same abstract class the
Drizzle adapter implements. Use-case unit tests construct the use case directly with
in-memory repositories — no container, no database, no mocking framework.

**The addition: in-memory repositories are tenant-scoped.** Unlike the reference's,
each one holds `tenant_id` on its items and filters every read by the tenant in
context. A use case that forgets to propagate tenant context fails in the unit suite,
in milliseconds, rather than surviving to be caught by RLS in an e2e test — or not
caught at all, if the query happened to be one RLS could not constrain.

**Tenant isolation tests are mandatory.** Every test creates its own tenant, and for
each aggregate there is a test that writes under tenant A and asserts tenant B cannot
read it. RLS is proven per aggregate, never assumed from the fact that a policy
exists.

## Consequences

- Unit tests read as behaviour: three lines of arrange, one act, one assert.
- Adding a field to an aggregate means updating one factory, not every test.
- Ten sets of factories and in-memory repositories, one per module. Duplication
  accepted per ADR 0001.
- In-memory repositories are real code with real bugs. They are kept trivially simple —
  an array and a filter — and any behaviour they cannot express honestly (a
  database-computed value, a unique constraint) is tested in e2e instead of faked.

## Alternatives considered

**`vi.mock` / `vi.fn()` doubles.** Rejected: the resulting tests assert that a method
was called with certain arguments, which is a test of the test's own assumptions. An
in-memory repository lets the test assert on resulting state.

**Fixtures loaded from JSON.** Rejected: static fixtures rot, and overriding one field
of a fixture is awkward enough that tests copy fixtures instead.

**Testing every use case against Testcontainers.** Rejected on speed; the unit suite
runs on every `pre-push`, and it must stay in the low seconds.
