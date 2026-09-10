# Bootstrap a new independent module

Extracted from `identity/` and the patterns in this directory. Follow this sequence
when phase 6 implements Catalog; fix gaps here rather than silently improvising them.

1. Confirm the module is declared in `scripts/modules.json` and has its own manifest,
   lockfile, dependencies, TypeScript, Biome, unit/e2e configuration and container.
2. Define ownership and non-goals in its README. Specify domain values, aggregates,
   repository ports, use cases and versioned external events before HTTP adapters.
3. Copy the required local tactical kernel. Keep imports inside the module; consume
   `@horizon/contracts` only at an exact published registry pin.
4. Add tenant-scoped factories and fakes, then behavior tests for success, errors and
   cross-tenant isolation. Keep snapshot access in infrastructure/test helpers.
5. Generate Drizzle schema migrations. Add tenant-leading keys, same-tenant references,
   enabled and forced RLS, explicit grants and separate migration/application roles.
6. Implement the private transaction executor and repository mappings. Test rollback,
   concurrency and pooled tenant reset against PostgreSQL under real non-superuser roles.
7. Add audit chaining, field redaction and subject encryption where personal data exists.
   Test tampering and erasure without modifying retained ciphertext.
8. Persist outgoing events in the transaction and add a restricted relay. For consumed
   events, add inbox deduplication, durable queues, bounded prefetch and dead-letter rules.
   Prove duplicate and crash/failure behavior with the broker.
9. Add local permission expansion, signature and revocation checks, HTTP validation,
   allowlisted presenters and the shared problem shape. Add optional HTTP idempotency
   with explicit credential-exchange exclusions.
10. Wire validated environment, health, telemetry and graceful shutdown. Add timeouts,
    bulkheads, metrics and a breaker for every actual cross-module dependency.
11. Run boundaries, lint, types, unit coverage (all gates at least 80%), build and e2e.
    Update endpoints, configuration and operational instructions from the tested code.
12. Record remaining scope honestly. Expand/contract migration evidence belongs to
    phase 6; do not mark a placeholder migration recipe as demonstrated.
