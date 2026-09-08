# 18. EdDSA (Ed25519) access tokens instead of RS256

- Status: accepted
- Date: 2026-09-07
- See also: [0036](0036-kong-oss-has-no-jwks-so-the-gateway-config-is-rendered.md) — Kong OSS was confirmed to verify EdDSA, so this decision stands; how the gateway obtains the key changed

## Context

Access tokens are verified on every request, twice: at Kong, and again locally by the
receiving module (`TRUST_GATEWAY_JWT=false` by default), so a service reached directly
on its port is not defenceless. Verification cost and token size are therefore on the
hot path.

RS256 is the default choice almost everywhere. It is the right choice
when unknown third parties must verify tokens with legacy libraries. Horizon has no
such consumer: the only verifiers are Kong and Horizon's own modules, both of which
are current software chosen by this project. Third-party access uses API keys, which
are a separate mechanism entirely (ADR 0022).

## Decision

**EdDSA with Ed25519** for access token signing.

- Access token lifetime 15 minutes, carrying `sub`, `tenant_id`, module-scoped `roles`
  (ADR 0023), `jti` and `kid`.
- `identity/` publishes JWKS at `/.well-known/jwks.json`. Kong validates against it;
  downstream modules re-verify locally by default.
- Private keys are mounted from files in development and read from AWS Secrets Manager
  in the Terraform definition. **Never committed.**
  `infra/scripts/generate-keys.sh` produces development keys into a gitignored path.
- Rotation is by publishing multiple `kid` entries in the JWKS with an overlap window
  longer than the maximum token lifetime.

## Consequences

- A 32-byte public key and a 64-byte signature, against 256 bytes of signature for
  RSA-2048. Tokens are meaningfully smaller, which matters when every request carries
  one through a gateway and on to a service.
- Ed25519 signing is roughly an order of magnitude faster than RSA-2048 signing, and
  verification is competitive. `identity/` signs on every login and refresh; every
  service verifies on every request.
- Ed25519 signatures are deterministic and the scheme has no padding, so the entire
  class of RSA padding-oracle and signature-malleability issues does not apply.
- Key generation is instant, which makes rotation cheap enough to actually practise.
- Anything that can only verify RS256 cannot consume these tokens. Accepted — nothing
  needs to, and if a future integration does, it gets an API key.
- The `alg` field must be pinned to `EdDSA` at every verifier. A verifier that trusts
  the token's own `alg` header accepts `none`. This is a test case, not a comment.

## Alternatives considered

**RS256.** Universal library support. Rejected: the compatibility it buys has no
consumer here, and it costs token size, signing speed, and a larger cryptographic
attack surface.

**ES256 (ECDSA P-256).** A reasonable middle ground with broad support. Rejected:
ECDSA signing requires a per-signature nonce, and nonce reuse or bias leaks the
private key — a failure mode Ed25519's deterministic construction removes entirely.

**HS256 (shared secret).** Rejected: every verifier would hold the signing key, so any
compromised service could mint tokens for the whole system. Asymmetric signing means
only `identity/` can issue.
