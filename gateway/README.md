# `gateway/`

Kong's declarative configuration — the single public entry point to Horizon.

**Status: phase 1 — scaffold.** `kong.yml` declares its shape and is validated in CI.
Services, routes and the plugin set are filled in during phase 2, after the platform has
been proven against a running stack.

---

## What this project owns

- **Routing.** Which path reaches which service, and on which upstream.
- **Cross-cutting request policy**, applied once here instead of five times in the
  services: JWT validation against `identity/`'s JWKS, rate limiting (global,
  per-consumer, per-API-key), request size limiting, correlation ids, CORS, and
  OpenTelemetry span emission.
- **Consumer and rate-limit tiers**, declared statically.

## What it explicitly does not own

- **Authorization.** The gateway validates that a token is authentic. What it permits is
  decided by the receiving module, from its own role map (ADR 0023).
- **Being the only check.** Services re-verify every token locally by default
  (`TRUST_GATEWAY_JWT=false`), so reaching a service's port directly grants nothing. The
  gateway is defence in depth and the place policy lives, not the sole gate.
- **API key existence.** Keys are created at runtime and validated by `identity/`. Kong
  enforces the rate-limit tier attached to a key's consumer group.
- **State.** Kong runs DB-less. There is no gateway database to run, back up or migrate.

---

## Working on it

```bash
npm run lint    # deck file validate kong.yml
```

`deck` is a Go binary and is not an npm dependency. Install it from
<https://github.com/Kong/deck> or run it through its container image; CI installs it in
the workflow. This is the one project whose tooling is not `npm install`-able, which is
why it carries a `package.json` with only the scripts the root `Makefile` calls.

Kong publishes no Alpine image in current versions, so the "Alpine where a variant
exists" rule does not apply to this service.
