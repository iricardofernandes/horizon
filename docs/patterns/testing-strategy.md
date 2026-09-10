# Testing the claims

Source: `identity/vitest.config.mts`, `vitest.config.e2e.mts`, `test/setup-e2e.ts`,
`test/factories/`, `test/repositories/`, and colocated domain/application tests.

Unit tests use factories, injected clocks, deterministic cryptography fakes and
repositories scoped by tenant. Cover successful transitions and meaningful failure
paths: stale credentials, erased subjects, insufficient grants, invalid values,
transaction rollback and audit side effects. A fake must copy persisted entities so
mutating a loaded object does not simulate a save that never happened.

Integration suites start fresh PostgreSQL, Redis and RabbitMQ via Testcontainers.
Create cluster administration separately from the non-superuser migration owner and
application roles. Apply the same migrations and default privileges as development;
a superuser test connection cannot prove RLS. Administrative connections exist only to
inspect ciphertext, inject tampering and provision roles.

Every aggregate needs a cross-tenant test. Add explicit race tests for refresh CAS,
revocation versus stale saves, concurrent audit appends and two outbox relays. Stop
Redis and exercise asymmetric denial; bind and unbind real broker queues. Prefer
barriers and controlled clocks to long sleeps.

Run types, lint, boundaries, unit coverage and e2e before committing a completed slice.
The 80% coverage threshold applies to domain and application only. Infrastructure's
proof is its observable behavior under real dependencies, not line coverage.

For another module, replace factories and business assertions while retaining the
role setup and mandatory failure/race cases. Tests should expose a defect before its
fix and remain as regression coverage; do not lower thresholds to declare completion.
