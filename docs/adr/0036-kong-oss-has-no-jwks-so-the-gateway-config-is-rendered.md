# 36. Kong OSS has no JWKS plugin, so the gateway configuration is rendered

- Status: accepted
- Date: 2026-09-07
- Amends: [0008](0008-kong-dbless-declarative-gateway.md), [0018](0018-eddsa-access-tokens.md)

## Context

ADR 0008 says Kong validates access tokens "against `identity/`'s JWKS". ADR 0018 chose
EdDSA (Ed25519) and a JWKS endpoint with `kid`-based rotation. Both were written before
the platform existed. Bringing Kong up in phase 2 established what is actually true:

- **Kong OSS does verify EdDSA.** Its `jwt` plugin implements RFC 8037; `EdDSA` is in the
  `alg_verify` table and in the `jwt_secrets` algorithm enum, verified against the plugin
  source in `kong:3.9`. ADR 0018 survives unchanged, which was the open question.
- **Kong OSS cannot fetch a JWKS document.** No bundled plugin does it. `openid-connect`
  and `jwt-signer`, which would, are Enterprise-only. The bundled `jwt` plugin resolves a
  key by matching a claim — `iss` by default — against a credential attached to a
  consumer, and that credential must be present in the declarative configuration.

So the public key has to be *in* `kong.yml`. That conflicts with keeping key handling in
one place and with rotating by publishing a new `kid` to JWKS.

## Decision

**The committed `gateway/kong.yml` stays key-free, and the runnable configuration is
rendered.**

- `gateway/kong.yml` holds services, routes and plugins, declares no consumers, and is
  what `deck file validate` checks in CI.
- `infra/scripts/render-kong-config.sh` reads the current Ed25519 public keys and writes
  `infra/generated/kong.generated.yml` — gitignored — adding one `jwt_secrets` entry per
  `kid`. That file is what the container mounts.
- Rotation is: generate a new `kid`, re-render, reload. Both keys are present during the
  overlap window, exactly as they would be in a JWKS document.
- In the Terraform definition the same script reads from AWS Secrets Manager instead of
  from disk.

**`identity/` still publishes `/.well-known/jwks.json`.** It is the source of truth for
every other verifier — the services, and any future consumer — and the render script is a
Kong-shaped adapter over the same keys, not a replacement for the endpoint.

**Enforcement does not depend on the gateway.** Every service re-verifies the token
locally (`TRUST_GATEWAY_JWT=false`), which was already the design in ADR 0008. Gateway
validation is defence in depth and a fast rejection at the edge; if it failed open,
nothing would be granted.

## Consequences

- Kong rejects a token signed by a key it does not hold. This is asserted by
  `infra/scripts/smoke.sh` through a dedicated `/gateway/verify` route that has no
  upstream — `request-termination` answers directly — so the check proves the gateway's
  own behaviour rather than a service's. Valid token 200, unknown key 401, no token 401.
- There is a generated artefact between the committed configuration and what runs. It is
  reproducible from committed inputs plus keys, and `make up` renders it, so the two
  cannot drift silently. But `gateway/kong.yml` alone is no longer the whole truth, and
  the file says so at the top.
- Rotation touches the gateway. With a real JWKS-fetching gateway, publishing a new `kid`
  would be enough; here the render-and-reload step is required. For an overlap window
  measured in hours that is acceptable, and it is scripted.
- `deck` requires a `secret` field on a `jwt_secrets` entry even when the algorithm is
  asymmetric and ignores it. The render script emits a random value rather than a fixed
  placeholder, so it cannot be mistaken for a shared secret that means something.

## Alternatives considered

**Kong Enterprise (`openid-connect`).** Does exactly what ADR 0008 described. Rejected:
this is a public portfolio project and an Enterprise licence is not available to a
reviewer, which would make the gateway configuration unreproducible.

**A custom Lua plugin that fetches JWKS.** Genuinely the "right" fix, and it would keep
`kong.yml` static. Rejected as disproportionate: a Lua plugin, its build into a custom
Kong image, and its tests, to avoid a fifteen-line shell script — and it would put
security-critical code in a language nothing else in the repository uses.

**Drop gateway JWT validation entirely** and rely on the services, which already verify.
Tempting, and defensible, because the services are the real enforcement. Rejected: edge
rejection of an unauthenticated request is worth having, it keeps the gateway's
authorization posture visible in one file, and abandoning it would leave ADR 0008's claim
about the gateway simply untrue.

**Switch to RS256 or ES256 so a wider set of gateways could fetch JWKS.** Rejected: the
constraint is Kong OSS's lack of a JWKS fetcher, not the algorithm — Kong verifies EdDSA
fine. Changing the signature algorithm would not remove the render step.
