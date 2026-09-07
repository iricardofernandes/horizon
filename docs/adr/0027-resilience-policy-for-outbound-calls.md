# 27. Resilience policy for every outbound call

- Status: accepted
- Date: 2026-09-07

## Context

In a single process, a slow function is slow. In a distributed system, a slow
dependency is an outage: callers pile up waiting, each holding a connection and a
thread's worth of memory, until the caller exhausts its own resources and fails for
every request — including those that never touched the slow dependency. The failure
propagates outward faster than the original fault.

Node's defaults actively encourage this. `fetch` has no default timeout. A `pg` query
has no default statement timeout. An AMQP consumer with no prefetch limit will accept
every message the broker offers.

## Decision

A single policy, applied to **every** outbound call — HTTP, database query, broker
operation — and documented once in `docs/patterns/resilience.md`.

**Timeouts.** Explicit on every call. **No unbounded wait anywhere.** Values are
configuration, not literals, and the total of a request's downstream timeouts is
smaller than the request's own timeout, so a caller never outlives its callee's
deadline.

**Circuit breakers** between modules. Closed → open on a failure-rate threshold →
half-open probing with a limited number of trial requests → closed on success. Breaker
state is exposed as a metric, so an open breaker is visible on a dashboard rather than
inferred from an error rate.

**Retries with exponential backoff *and jitter*.** Jitter is not optional: without it,
every client that failed at the same moment retries at the same moment, and the
recovering dependency is knocked over again by a synchronised thundering herd. Retry
**only idempotent operations**; never retry a non-idempotent write without an
idempotency key (ADR 0028).

**Bounded concurrency.** Every consumer sets an AMQP prefetch limit. Every connection
pool has a maximum. A documented backpressure policy states what happens when a queue
grows past a threshold — alert, shed, or pause the producer — rather than letting the
answer be "the broker fills its disk".

**Bulkheads.** A slow dependency in one code path must not exhaust the pool the others
use. Separate pools per dependency class, so a degraded webhook target cannot consume
the connections the order path needs.

## Consequences

- A failing dependency degrades one code path instead of the service.
- An open breaker fails fast, which frees the caller's resources and lets the
  dependency recover instead of being held under load by its own clients.
- Timeouts must be chosen, and a wrong one causes failures a longer timeout would have
  avoided. Values start from measured p99 latency and are revised from data, not from
  intuition. This is why the golden path is load-tested (Phase 8): the benchmark
  produces the numbers the timeouts are set from.
- Retries multiply load on a struggling dependency. Bounded attempt counts and the
  breaker together cap the amplification.
- Every one of these is a metric: breaker state, retry count, timeout count, pool
  saturation, queue depth. A resilience mechanism with no telemetry cannot be tuned and
  cannot be trusted.
- More configuration surface per module. Accepted; it is validated at boot with the
  rest of the environment (ADR 0033's boot-time validation), so a missing timeout is a
  startup failure rather than an infinite wait in production.

## Alternatives considered

**Retries alone.** The common half-measure. Rejected: retries without a breaker amplify
load precisely when the dependency is least able to take it.

**A service mesh (Istio, Linkerd) handling this at the infrastructure layer.** The
right answer at scale, and it removes the policy from application code entirely.
Rejected as disproportionate operational surface for five services, and because
implementing the patterns in application code is the thing this project is meant to
demonstrate.

**Per-call ad-hoc handling.** Rejected: it guarantees drift, and the calls that get
forgotten are the ones that cause the incident.
