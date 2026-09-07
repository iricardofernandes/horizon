# 21. `jti` denylist in Redis, with asymmetric failure behaviour

- Status: accepted
- Date: 2026-09-07

## Context

A stateless access token is valid until it expires. Logging out, revoking a session,
disabling a user or detecting refresh-token reuse (ADR 0020) must take effect before
the 15-minute lifetime elapses, which requires state.

Adding state to token validation creates a dependency: what should a service do when
that state is unreachable? Answering "always fail closed" makes Redis a
single-point-of-failure for the entire product — an outage becomes a total outage.
Answering "always fail open" means a revoked token keeps working during exactly the
incident an attacker would choose.

## Decision

A **Redis denylist keyed by `jti`**, with TTL equal to the token's remaining lifetime,
so entries expire on their own and the list never grows without bound.

On **Redis unavailability**, behaviour is asymmetric and explicit:

- **Fail closed for privileged operations** — every write, every state change, every
  administrative read.
- **Fail open for read-only operations** — non-privileged `GET` requests proceed.

The distinction is a property of the route, declared at the handler and visible in the
generated OpenAPI, not inferred from the HTTP verb at runtime.

## Consequences

- Revocation is effective within the denylist write's propagation, not within 15
  minutes.
- The denylist is small: only tokens revoked before their natural expiry, each living
  at most 15 minutes.
- **The tradeoff, stated plainly:** during a Redis outage, a token revoked in the last
  15 minutes can still perform reads. The window is bounded by the access token
  lifetime, the exposure is limited to data the token's owner could already read, and
  nothing can be changed. The alternative — a total outage on every Redis blip — is a
  worse expected outcome for an ERP, where a read-only degraded mode is genuinely
  useful and a write-blocked one is safe.
- This is a deliberate, documented weakening. It is repeated in `identity/README.md`
  and in `docs/architecture.md` so it cannot be discovered later as if it were an
  oversight.
- The behaviour is tested: a suite runs with Redis stopped and asserts that writes are
  refused and reads succeed.
- Every denial and every fail-open decision is logged with the `jti` and the reason, so
  an outage's exposure is measurable after the fact rather than estimated.

## Alternatives considered

**Fail closed always.** Rejected: it converts a cache outage into a product outage, and
the resulting pressure to make Redis highly available is out of proportion to the
15-minute exposure being prevented.

**Fail open always.** Rejected: it lets a revoked token write.

**No denylist; rely on the 15-minute expiry.** Rejected: refresh-token reuse detection
(ADR 0020) must be able to cut off an in-flight attacker immediately, and disabling a
compromised account must mean something before the next quarter hour.

**Short-lived tokens (30 seconds) instead of a denylist.** Effective, and it moves the
load to `identity/`, which would then be on the hot path of every request. Rejected:
it trades a soft dependency on Redis for a hard dependency on a service.
