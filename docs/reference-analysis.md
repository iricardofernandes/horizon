# Reference analysis — `nest-clean`

`~/dev/test/nest-clean` is a single-service NestJS forum built on Clean Architecture
and DDD tactical patterns. It is used here for **one thing: how the code is written** —
the shape of repositories, use cases, entities, value objects, mappers, factories and
tests, and the vocabulary those files use.

**It is not an architectural input.** Horizon's infrastructure decisions — Drizzle,
Testcontainers, RLS, the outbox, EdDSA, Argon2id, the observability plane — are made on
their own merits and recorded in `docs/adr/`. Where this document mentions the
reference's choice of Prisma, bcrypt, RS256 or its test bootstrap, it is to say those
are out of scope, not to argue against them.

The question this document answers is therefore narrow: **when Horizon writes a
repository, a use case or an entity, which of the reference's conventions does it
follow, which does it write differently, and which does it not carry over?**

---

## 1. The writing model — reproduced

### 1.1 The tactical kernel, `src/core/`

Small, dependency-free, and the part worth taking wholesale. Copied into each module at
`<module>/src/core/` — copied rather than shared, for the reasons in ADR 0031.

| Reference file | Contents | Status |
|---|---|---|
| `src/core/either.ts` | `Left`, `Right`, `left()`, `right()` | Verbatim |
| `src/core/entities/entity.ts` | `Entity<Props>` | Reproduced; `equals()` corrected (§3.1) |
| `src/core/entities/aggregate-root.ts` | `AggregateRoot<Props>`, `addDomainEvent()` | Reproduced; dispatch changed (§2.3) |
| `src/core/entities/unique-entity-id.ts` | `UniqueEntityID` | Reproduced; UUIDv7 inside (ADR 0009) |
| `src/core/entities/value-object.ts` | `ValueObject<Props>` | Reproduced; `equals()` corrected (§3.2) |
| `src/core/entities/watched-list.ts` | `WatchedList<T>` | Verbatim |
| `src/core/errors/use-case-error.ts`, `errors/errors/*.ts` | `UseCaseError`, `ResourceNotFoundError`, `NotAllowedError` | Reproduced as the base of a wider taxonomy |
| `src/core/repositories/pagination-params.ts` | `PaginationParams` | Reproduced, extended (§2.5) |
| `src/core/types/optional.ts` | `Optional<T, K>` | Verbatim |

`Either` with `isLeft()` / `isRight()` as **type predicates** is what makes exhaustive
narrowing work without a library, and `Optional<T, K>` is what makes the `create()`
factory ergonomic — `Question.create()` accepts
`Optional<QuestionProps, 'createdAt' | 'slug' | 'attachments'>` and fills the rest.

`WatchedList<T>` is the one piece of the kernel with real behaviour: `getNewItems()` and
`getRemovedItems()` let a repository issue a minimal diff on `save()` rather than
replacing a child collection. `QuestionAttachmentList` shows the idiom —
a three-line subclass declaring only `compareItems`. Horizon writes `OrderLines` and
`StockMovements` the same way.

### 1.2 Layer vocabulary and the dependency rule

The reference splits `src/domain/<context>/enterprise` (entities, VOs, events) from
`src/domain/<context>/application` (use cases, repository interfaces, ports), with
`src/infra/` holding everything framework-shaped. `CreateQuestionUseCase` depends on the
abstract `QuestionsRepository`, never on `PrismaQuestionsRepository`.

The rule is reproduced. The folder names are not: `enterprise` and `application` as
siblings under a context name is course vocabulary, and this repository is read by
strangers. Horizon uses `domain/`, `application/`, `infrastructure/`, `main/`
(ADR 0031).

### 1.3 Abstract classes as repository interfaces and DI tokens

`src/domain/forum/application/repositories/questions-repository.ts`:

```ts
export abstract class QuestionsRepository {
  abstract findById(id: string): Promise<Question | null>
  abstract create(question: Question): Promise<void>
  abstract save(question: Question): Promise<void>
  abstract delete(question: Question): Promise<void>
}
```

wired in `src/infra/database/database.module.ts` as
`{ provide: QuestionsRepository, useClass: PrismaQuestionsRepository }`.

An abstract class is simultaneously the compile-time interface and the runtime DI
token, which removes the `@Inject('TOKEN')` string-literal pattern entirely. Adopted
without change — it is the single most useful convention in the project, and it is why
`domain/` can define a port that `infrastructure/` implements with no shared symbol
beyond the class itself.

Method vocabulary is kept too: `findById` / `findBySlug` / `findMany*` for reads,
`create` / `save` / `delete` for writes, entity in and entity out, never a row type.

### 1.4 Use case shape

`CreateQuestionUseCase` and `EditQuestionUseCase` establish the template Horizon
follows:

- one class, one public `execute()`, constructor-injected repositories;
- a local `interface XUseCaseRequest` and `type XUseCaseResponse = Either<...>` declared
  immediately above the class, so the contract is readable without scrolling;
- guard clauses returning `left(new ResourceNotFoundError())` early;
- `right({ ... })` as the single success exit.

`EditQuestionUseCase` is the canonical example: load, guard for existence, guard for
permission, mutate, save, return. Horizon's use cases are written in that order.

### 1.5 Static `create()` factories on entities

Every entity constructs through `static create(props, id?)` rather than `new`.
`Question.create()` derives `slug` from `title`, defaults `attachments` to an empty
`QuestionAttachmentList` and `createdAt` to now.

Reproduced, and tightened: in Horizon `create()` is the **only** construction path, and
it returns `Either<InvalidX, X>` where the aggregate has invariants that can fail.
`Money.create()` and `Cnpj.create()` can fail; `Question.create()` could not, which is
why the reference has no example of it.

### 1.6 Mappers at the persistence boundary

`src/infra/database/prisma/mappers/prisma-question-mapper.ts` exposes static
`toDomain(raw)` and `toPrisma(entity)`. Ten such mappers exist, one per aggregate,
each doing nothing but translate.

Reproduced as
`src/infrastructure/database/drizzle/mappers/<aggregate>-mapper.ts` with `toDomain` /
`toPersistence`. This is the convention that makes §2.1 implementable: with no accessors
on entities, the mapper is the only sanctioned reader of aggregate state.

### 1.7 In-memory repositories

`test/repositories/in-memory-*-repository.ts` implement the same abstract class the
production adapter implements, holding a plain `public items: T[]`. A use case spec then
reads:

```ts
sut = new CreateQuestionUseCase(inMemoryQuestionsRepository)
```

No container, no database, no mocking framework. Nine exist.

Reproduced per module, with one addition: Horizon's are **tenant-scoped**, so a use case
that fails to propagate tenant context fails in the unit suite rather than relying on
RLS to catch it later (ADR 0014).

### 1.8 Factories, in two halves

`test/factories/make-question.ts` exports both:

- `makeQuestion(override, id)` — a pure builder over `@faker-js/faker`, every field
  overridable;
- `@Injectable() class QuestionFactory` with `makePrismaQuestion()` — persists through
  the **same mapper the production repository uses**.

E2E specs then seed in one line via `moduleRef.get(StudentFactory)`, as
`create-question.controller.e2e-spec.ts` does.

Reproduced exactly, per the brief's §2. The dual shape is the point: unit and e2e share
one definition of a valid aggregate, and persistence goes through the mapper so a mapper
bug fails the setup rather than hiding in it.

### 1.9 Zod at the HTTP boundary

`src/infra/http/pipes/zod-validation-pipe.ts` wraps a `ZodSchema` in a `PipeTransform`;
the controller declares the schema, derives its body type with `z.infer`, and binds
`new ZodValidationPipe(schema)` per parameter. No `class-validator` decorators, and the
DTO type is free.

Reproduced. What the pipe throws changes (§2.2), and cross-module payload schemas come
from `@horizon/contracts` rather than being declared inline, so the wire contract has one
definition (ADR 0029).

### 1.10 Presenters

`src/infra/http/presenters/question-presenter.ts` maps a domain object to the response
shape as a static `toHttp()`. Reproduced, and promoted from convention to requirement:
with no accessors on entities, a presenter is the only path from an aggregate to a
response body.

### 1.11 Environment validation at boot

`src/infra/env/env.ts` declares `envSchema` with Zod; `app.module.ts` passes
`validate: (env) => envSchema.parse(env)`; `EnvService.get()` returns a typed value
through `ConfigService<Env, true>`. Reproduced in shape — it already satisfies the
brief's "refuses to start on invalid configuration".

### 1.12 Test file layout

`*.spec.ts` colocated with the use case; `*.e2e-spec.ts` under a second Vitest config
with `include: ['**/*.e2e-spec.ts']` and a setup file. Reproduced as
`vitest.config.ts` / `vitest.config.e2e.ts` per module.

---

## 2. Written differently

### 2.1 Entities: accessors → behaviour plus one snapshot

`Question` exposes ten getters and four setters. `EditQuestionUseCase` changes state by
assignment:

```ts
question.title = title
question.content = content
question.attachments = questionAttachmentList
```

with a private `touch()` firing as a side effect of each setter. No method on the
aggregate expresses what is happening; the use case orchestrates every change field by
field.

The brief's §11 forbids this. Horizon's entities expose **intention-revealing methods** —
`order.confirm()`, `order.addLine(...)`, `stock.reserve(...)` — that enforce invariants,
and expose no property accessors.

That leaves mappers and presenters needing a way in. The mechanism, chosen once so five
modules do not each invent one: **every aggregate exposes exactly one
`toSnapshot(): Readonly<Snapshot>`** returning a frozen struct of primitives and VO
snapshots. Mappers and presenters consume it; nothing else may, and the boundary script
asserts `toSnapshot()` is referenced only under `infrastructure/`.

### 2.2 Controllers: keep the `Either`'s information

Every reference controller ends the same way:

```ts
if (result.isLeft()) {
  throw new BadRequestException()
}
```

The `Either` is discriminated and then discarded — `ResourceNotFoundError` and
`NotAllowedError` both become a bare 400 with no body. The type-level care in the use
case is thrown away one layer up, in fourteen controllers.

Horizon's controllers unwrap the `Either` and hand the left value to a global filter
keyed on error class, which emits RFC 9457 `application/problem+json`. A controller never
chooses a status code, and adding a domain error is one filter entry rather than N
controller edits (ADR 0032).

### 2.3 Domain events: keep the recording, change the dispatch

`src/core/events/domain-events.ts` is a static class holding
`handlersMap: Record<string, DomainEventCallback[]>` and a `markedAggregates` array.
Repositories call `DomainEvents.dispatchEventsForAggregate(question.id)` after writing —
see `InMemoryQuestionsRepository.create()` — and subscribers such as `OnAnswerCreated`
register themselves in their constructor.

The **recording** half is kept: `AggregateRoot.addDomainEvent()`, aggregates accumulating
what happened, is exactly right.

The **dispatch** half is not carried over, for two reasons that are visible in the
reference itself. It is a static mutable global — `DomainEvents.clearHandlers()` exists
solely to stop parallel test workers interfering — and dispatch happens after the write
rather than within it. Horizon's repositories pull the events off the aggregate and write
them to the outbox inside the same transaction; subscribers are wired through Nest DI
rather than a static `register()` call, so they are testable in isolation (ADR 0024).

### 2.4 Repository writes are transactional

`PrismaQuestionsRepository.save()` fires three statements in a `Promise.all` — update the
question, create new attachments, delete removed ones — with no transaction. A partial
failure leaves attachments inconsistent with their question.

Horizon keeps the `WatchedList` diff and wraps the statements in the tenant transaction,
so the aggregate, its child collections and the outbox row commit or fail together.

### 2.5 Pagination

`PaginationParams` is `{ page: number }`, and the page size 20 is hard-coded in
`findManyRecent` (`take: 20`, `skip: (page - 1) * 20`) and again in the in-memory
repository (`.slice((page - 1) * 20, page * 20)`).

Horizon's `PaginationParams` carries an explicit limit with a bounded maximum, and lists
that can grow without bound use keyset pagination on `(tenant_id, created_at, id)`.

---

## 3. Not carried over

Code-level defects in files Horizon would otherwise have copied. Listed because each one
would have been inherited silently.

### 3.1 `Entity.equals()` compares identity by reference

```ts
if (entity.id === this._id) { return true }
```

`_id` is a `UniqueEntityID` **object**, so this is reference equality: two entities loaded
separately with the same UUID compare unequal. `UniqueEntityID.equals()` exists and is
correct, and `DomainEvents.findMarkedAggregateByID()` uses it properly — `Entity.equals()`
simply does not. The consequence is visible in
`InMemoryQuestionsRepository.save()`, which finds rows with
`findIndex((item) => item.id === question.id)` and works only because the array holds the
identical object instance.

Horizon: `this._id.equals(entity.id)`.

### 3.2 `ValueObject.equals()` via `JSON.stringify`

Property-order dependent, and silently wrong for `Date`, `undefined`, `Map` and `Set`.
`bigint` does not fail silently — `JSON.stringify` throws on it — and Horizon's `Money` is
backed by `bigint` (ADR 0010), so this would break outright. Replaced by a structural
comparison the value object declares, in the spirit of `WatchedList.compareItems`.

### 3.3 `QuestionPresenter` serialises a function reference

```ts
bestAnswerId: question.bestAnswerId?.toString,
```

Missing call parentheses, so the field is a function and disappears through
`JSON.stringify`. A one-character defect that no test caught — which is the argument for
e2e specs asserting on the **response body**, not only on database state.

### 3.4 `UniqueEntityID` defaults to `randomUUID()`

UUIDv4 fragments B-tree indexes on insert. The class's public surface is kept; UUIDv7 goes
inside it (ADR 0009).

### 3.5 Portuguese in code and output

`OnAnswerCreated` builds `` `Nova resposta em "..."` ``; `create-question.spec.ts` asserts
on `'Nova pergunta'` and `'Conteúdo da pergunta'`. Horizon is English-only, with Brazilian
fiscal terms the sole exception, defined in `docs/glossary.md`.

### 3.6 Loosened strictness and stray files

`tsconfig.json` declares `"strict": true` and then sets `noImplicitAny: false`,
`strictBindCallApply: false` and `forceConsistentCasingInFileNames: false`.
`ZodValidationPipe.transform` has an unreachable `return value` after its `try`/`catch`;
`src/infra/http/presenters/comment.ts` is unused; `js.js` and `client.http` sit at the
root. Horizon runs strict genuinely (ADR 0005) and dead-code checks in CI.

---

## 4. Explicitly out of scope

The reference's infrastructure choices are **not** inputs to Horizon's. Prisma, bcryptjs,
RS256 with committed `private_key.pem`/`public_key.pem`, its `docker-compose.yml`, and its
schema-per-run `test/setup-e2e.ts` are all reasonable for a single-service teaching
project and simply answer different questions than Horizon asks. Horizon's counterparts
are argued from its own constraints — multi-tenancy, five databases, at-least-once
messaging — in ADRs 0007, 0013, 0018 and 0019, none of which needs the reference to make
its case.

The one carry-over worth naming: **`*.pem` files are gitignored and key material is never
committed**, which is a rule Horizon holds regardless of where the observation came from.

---

## 5. Summary

| Writing concern | Reference | Horizon |
|---|---|---|
| Result type | `Either` with `isLeft`/`isRight` predicates | Same, verbatim |
| Entity base | `Entity`, `AggregateRoot` | Same; `equals()` fixed |
| Identity | `UniqueEntityID` | Same class, UUIDv7 inside |
| Value objects | `ValueObject` + `JSON.stringify` equality | Same class, structural equality |
| Child collections | `WatchedList` + 3-line subclass | Same |
| Construction | `static create(props, id?)` with `Optional<>` | Same; returns `Either` when it can fail |
| Entity data access | ten getters, four setters | behaviour methods + one `toSnapshot()` |
| Repository interface | abstract class as interface and DI token | Same |
| Repository writes | `Promise.all`, no transaction | Same diff, inside the tenant transaction |
| Use case shape | request interface, `Either` response, guard clauses | Same |
| Controller | discards the `Either`, throws `BadRequestException` | unwraps it; global RFC 9457 filter |
| Mappers | static `toDomain` / `toPrisma` | static `toDomain` / `toPersistence` |
| Presenters | static `toHttp` | Same, and required |
| Validation | Zod schema + `PipeTransform` | Same; shared schemas from `@horizon/contracts` |
| Domain events | recorded on aggregate, dispatched by a static registry | recorded the same way, written to the outbox |
| In-memory repos | `public items: T[]` | Same, tenant-scoped |
| Factories | `makeX()` + `XFactory` persisting via the mapper | Same |
| Pagination | `{ page }`, size hard-coded twice | explicit bounded limit; keyset where unbounded |
| Test layout | colocated `.spec`, separate `.e2e-spec` config | Same |
