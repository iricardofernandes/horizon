# 31. Clean Architecture layering, and which Object Calisthenics rules apply

- Status: accepted
- Date: 2026-09-07

## Context

Clean Architecture and DDD tactical patterns are widely claimed and rarely enforced.
The value in this repository comes from the rules being mechanically checked, and from
being explicit about which ones are deliberately relaxed — a ruleset applied at 80%
with no statement of which 20% was dropped reads as sloppiness rather than judgement.

## Decision

### Layering, per module

```
src/
  domain/          entities, value objects, aggregates, domain events, repository interfaces
  application/     use cases, ports, application errors
  infrastructure/  drizzle repositories, http controllers, amqp publishers and consumers, redis
  main/            nest modules, wiring, bootstrap
```

**Dependencies point inward only.** `domain/` imports nothing from `application/`,
`infrastructure/`, `@nestjs/*`, `drizzle-orm` or `zod` — and, by extension, nothing from
`@horizon/contracts`, which is a Zod package. The boundary script verifies this
(ADR 0002).

Each module also carries its own copy of the tactical kernel at `src/core/` — `Either`,
`Entity`, `AggregateRoot`, `UniqueEntityID`, `ValueObject`, `WatchedList`, error bases,
pagination types — adapted from the reference project analysed in
`docs/reference-analysis.md`. It is **copied, not shared**: a shared kernel package
would be a fifth transport between modules and would couple their release cycles.
Divergence between copies is permitted and expected.

### Object Calisthenics — applied

1. **One level of indentation per method.** Extract rather than nest.
2. **No `else`.** Early return, guard clause, or polymorphism.
3. **Wrap primitives that carry meaning.** `Cnpj`, `Email`, `Money`, `Quantity`,
   `DocumentNumber` — never a bare `string` for a domain concept. Each validates in its
   constructor and is immutable.
4. **First-class collections.** A class holding a collection holds nothing else and
   carries the collection's behaviour: `OrderLines`, `StockMovements`.
5. **No getters and setters on entities.** Entities expose behaviour; data leaves only
   through an explicit mapper at the boundary. DTOs and Zod schemas are exempt.
6. **Small units.** Classes under ~100 lines, methods under ~15, at most 5 instance
   fields.

### The mechanism rule 5 requires

Rule 5 forbids accessors, but mappers and presenters must read entity data, and the
brief specifies only that it happens "through an explicit mapper at the boundary". The
mechanism, chosen here so it is uniform across modules rather than reinvented five
times:

**Every aggregate exposes exactly one `toSnapshot(): Readonly<Snapshot>`**, returning a
frozen plain struct of primitives and value-object snapshots. Mappers and presenters
consume `toSnapshot()`; nothing else may.

This keeps rule 5's intent — no property-by-property mutation, no accidental exposure of
internals, all state change through intention-revealing methods — while giving the
boundary a single, greppable, checkable seam. The boundary script asserts that
`toSnapshot()` is referenced only under `infrastructure/`.

This is a departure from the reference project, whose `Question` entity exposes ten
getters and four setters and whose use cases change state by assignment
(`question.title = title`). See `docs/reference-analysis.md` §3.5.

### Object Calisthenics — deliberately relaxed

**"One dot per line."** Relaxed. It fights Drizzle's query builder
(`db.select().from(t).where(eq(...)).limit(n)`) and every fluent builder, and applying
it would mean assigning each intermediate to a named variable that names nothing. The
rule's purpose — not reaching through an object into its collaborators' internals — is
served by rule 5 instead, which is enforceable.

**"No abbreviations."** Relaxed. Accepted domain abbreviations stay: `cnpj`, `ncm`,
`nfe`, `sped`, `icms`, `cfop`, `id`, `url`, `http`. Expanding them would produce
identifiers no Brazilian accountant and no engineer would recognise. They are defined in
`docs/glossary.md`. Invented abbreviations remain forbidden.

## Consequences

- The rules are checkable, and the checks run in CI and in the pre-commit hook.
- Writing a use case is more work: no `else`, one indentation level, primitives wrapped.
  The result is small units that unit-test without setup.
- Rule 5 forces real modelling. `order.confirm()` must decide what confirmation means
  and what it rejects, where `order.status = 'confirmed'` requires no such decision.
- The ~100/~15/5 limits are guidance with a lint warning, not a hard failure. A method
  that is genuinely one flat 18-line sequence is better than the same logic split into
  two methods that are only ever called together.
- The kernel is duplicated five times and will drift. Accepted, and named in
  `docs/patterns/tactical-kernel.md` so it reads as a decision.

## Alternatives considered

**Clean Architecture without Object Calisthenics.** Rejected: the layering alone leaves
anaemic entities and fat use cases, which is the shape the reference project has.

**All ten calisthenics rules.** Rejected for the two named above, with reasons rather
than silently.

**A shared `@horizon/kernel` package alongside `@horizon/contracts`.** Rejected:
`contracts/` is versioned because it is a wire contract with exactly two sides that must
agree. The kernel is internal structure; sharing it would couple five release cycles to
buy a few hundred lines.
