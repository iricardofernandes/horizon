# The local tactical kernel

Source: `identity/src/core/`; examples in `identity/src/domain/entities/` and
`identity/src/application/use-cases/`. Proof: domain/application unit suites and
`node scripts/check-boundaries.mjs`.

Copy the kernel into each independent module: value-based UniqueEntityID, Entity,
AggregateRoot, ValueObject, WatchedList, Either, expected errors, pagination and small
types. There is no shared kernel package. Each module may evolve its copy with its own
lockfile, tests and release lifecycle.

Aggregates expose behavior and accumulate domain events. Draining events is destructive
so a second save cannot announce them again. A single frozen snapshot leaves an
aggregate through a mapper or presenter, not through application use cases. Test
snapshot inspection belongs in test helpers because the mechanical boundary checker
also sees colocated spec files. Use behavior methods for application decisions.

Domain code imports no framework, ORM, Zod or another module's source. Repository ports
speak in entities and domain values. Infrastructure implements them using transactions;
Nest factory wiring supplies dependencies explicitly where type-only imports cannot
provide runtime decorator metadata.

For another module, keep only primitives it actually needs and implement its own
aggregates and event vocabulary. UUID identity equality must compare values rather
than object references. First-class collections must not leak mutable references.
Validate values before changing state and use factories so every test owns its tenant.
