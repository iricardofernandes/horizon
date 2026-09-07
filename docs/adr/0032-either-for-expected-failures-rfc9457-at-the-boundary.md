# 32. `Either` for expected failures, exceptions for faults, RFC 9457 at the boundary

- Status: accepted
- Date: 2026-09-07

## Context

Two different things are commonly called "errors", and conflating them is why error
handling in layered systems degrades into `try`/`catch` everywhere and a 500 for
anything unanticipated.

The first is an **expected outcome**: the order does not exist, the stock is
insufficient, the credentials are wrong. These are part of the use case's contract. A
caller must handle them, and the type system should say so.

The second is a **fault**: a null dereference, a broken invariant, a database that is
unreachable. Nobody can handle these locally; they must propagate, be logged with
context, and become a 500.

The reference project gets the first part right and then discards it. `EditQuestionUseCase`
returns `Either<ResourceNotFoundError | NotAllowedError, {question}>`, and its
controller does:

```ts
if (result.isLeft()) {
  throw new BadRequestException()
}
```

A "not found" and a "not allowed" both become a bare 400 with no body. The type-level
care is thrown away one layer up, and the pattern repeats in every controller.

## Decision

**Typed domain error classes. Never thrown strings.**

**Use cases return `Either<Error, Value>` for expected failures.** Exceptions are
reserved for programmer error and infrastructure failure.

**HTTP mapping happens once**, in a global exception filter driven by error class.
Controllers unwrap the `Either` and hand the left value to the filter; a controller
never chooses a status code.

**Responses follow RFC 9457 `application/problem+json`**, carrying `type`, `title`,
`status`, `detail`, `instance`, and a correlation id. Validation failures add a
`violations` member; the Zod validation pipe emits a problem document rather than the
reference's ad-hoc `{ message, statusCode, errors }` object.

## Consequences

- A use case's failure modes are visible in its signature. Adding one is a compile
  error at every call site, which is the point.
- Adding a domain error means adding one filter entry, not editing N controllers.
- The `Either` type comes from the module's own `src/core/either.ts`, with `isLeft()`
  and `isRight()` as type predicates, so narrowing is exhaustive without a library.
- Every error response has a machine-readable `type` URI, which makes client error
  handling something other than string matching on a message.
- The correlation id in every problem document ties a user-visible failure to a trace
  and to log lines (ADR 0033) — a support request becomes a Jaeger query.
- `Either` is verbose at call sites; every use case invocation is followed by a
  left/right branch. Accepted: that branch is the handling that would otherwise have
  been forgotten.
- Nest's own `HttpException` hierarchy is not used in application code. It appears only
  inside the filter, where the mapping happens.

## Alternatives considered

**Exceptions for everything, mapped by a filter.** Simpler and conventional. Rejected:
a use case's failure modes become invisible in its signature and discoverable only by
reading its body and everything it calls.

**Result types from a library (`neverthrow`, `fp-ts`).** More combinators, better
ergonomics. Rejected: `Either` is thirty lines, is copied into each module's kernel
(ADR 0031), and adding a dependency to five modules for thirty lines contradicts the
kernel decision.

**Plain error responses (`{ error: "..." }`).** Rejected: RFC 9457 is a standard, costs
nothing to follow, and gives clients a stable `type` to branch on.
