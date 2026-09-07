# 6. NestJS for services, Next.js for the frontend

- Status: accepted
- Date: 2026-09-07

## Context

Five backend services need HTTP handling, dependency injection, lifecycle hooks,
message consumers and graceful shutdown. The frontend needs routing, server
rendering, and a path to a live deployment on a free tier.

## Decision

**NestJS** for every backend service. **Next.js (App Router)** for `web/`.

Nest's dependency injection is used specifically as the seam that Clean Architecture
requires: abstract classes serve simultaneously as compile-time interfaces and
runtime DI tokens, so a use case depends on `ProductsRepository` and the container
supplies `DrizzleProductsRepository`. This is the one pattern from the reference
project adopted without modification.

Passport is **not** used. Token verification is implemented directly over `jose`
(ADR 0018), because a single custom strategy does not justify
`passport` + `passport-jwt` + `@nestjs/passport`, and because JWKS caching and `kid`
selection need direct control.

## Consequences

- Decorators and `emitDecoratorMetadata` are required, which constrains the
  TypeScript configuration (ADR 0005) and the Biome rule set.
- Nest's module system is a second layering vocabulary alongside Clean Architecture's.
  They are kept distinct: Nest modules live only in `src/main/`, and `domain/` never
  imports from `@nestjs/*` — enforced by the boundary script (ADR 0002).
- Nest brings `@nestjs/testing`, which makes e2e wiring against Testcontainers
  straightforward (ADR 0013).
- Next.js App Router gives server components and a first-class Vercel deployment
  path, which Phase 11 depends on.

## Alternatives considered

**Fastify without a framework**, or Hono. Lighter and faster. Rejected: the project
needs a DI container to make the Clean Architecture seam real, and hand-rolling one
would be incidental work that demonstrates nothing.

**Encore or NestJS microservices transport.** Both would take over the messaging
layer. Rejected: the outbox and inbox patterns (ADR 0024) are the point, and a
framework abstraction over AMQP would hide exactly the mechanics the project exists
to show. RabbitMQ is used through `amqplib` directly.

**Remix or SvelteKit** for `web/`. Rejected on ecosystem and deployment-path grounds
only; nothing in the architecture depends on the choice.
