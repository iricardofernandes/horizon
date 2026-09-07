# 8. Kong in DB-less declarative mode

- Status: accepted
- Date: 2026-09-07

## Context

Five services behind one public surface need a single place for JWT validation, rate
limiting, request size limits, CORS, correlation ids and trace propagation.
Implementing those five times, once per service, guarantees drift.

A gateway with its own PostgreSQL instance introduces a stateful component whose
configuration lives outside version control and is changed by API calls — meaning the
gateway's behaviour is not reviewable in a diff.

## Decision

**Kong in DB-less mode**, configured by a single declarative `gateway/kong.yml` held
in version control: services, routes, upstreams, plugins, consumers and per-key rate
limit tiers.

Plugins: JWT validation against `identity/`'s JWKS, rate limiting (global,
per-consumer, per-API-key), request size limiting, correlation id, CORS, and
OpenTelemetry.

CI runs `deck validate` against the file.

## Consequences

- Gateway behaviour changes arrive as reviewable diffs, and a rollback is a git
  revert.
- No gateway database to run, back up, or migrate.
- Configuration cannot be changed at runtime through the Admin API. That is the
  point; it also means any dynamic per-tenant routing would need a different
  mechanism. Horizon has no such requirement.
- Consumers and API-key tiers are declared statically. Per-tenant API keys are
  validated by `identity/` rather than by Kong's key-auth plugin, because keys are
  created at runtime; Kong enforces the *rate limit tier* attached to the key's
  consumer group, not the key's existence.
- Kong ships no Alpine image in current versions, so the "Alpine where a variant
  exists" rule does not apply to it.

## Alternatives considered

**Kong with PostgreSQL.** Rejected as described above.

**Traefik.** Lighter and Docker-native. Rejected: weaker plugin story for JWKS-based
JWT validation and per-consumer rate limiting without writing a plugin.

**Nginx or Envoy.** Both capable; Envoy in particular is the stronger production
answer. Rejected on configuration ergonomics for a project that needs the gateway to
be legible in a diff to a reader who is not an Envoy user.

**No gateway; each service validates its own token.** Rejected — but only halfway.
Services *do* re-verify locally by default (`TRUST_GATEWAY_JWT=false`), so a service
reached directly on its port is not defenceless. The gateway is defence in depth and
the place cross-cutting policy lives, not the only check.
