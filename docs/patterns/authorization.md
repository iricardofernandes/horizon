# Verified tenant context and local permissions

Source: `identity/src/infrastructure/http/authorization.ts`, `http-context.ts`,
`identity/src/infrastructure/cryptography/ed-dsa-access-token-signer.ts`, and
`identity/src/domain/value-objects/role-assignments.ts`. Proof: signing, role and HTTP tests.

Verify the bearer signature locally with a pinned EdDSA algorithm, known kid and
matching issuer. Reject malformed or expired claims. Never treat a client-provided
tenant header as authority, even when Kong sits in front of the service. Public routes
are explicitly marked. Protected routes derive actor and tenant from verified claims.

Identity stores opaque module/role pairs. Each receiving module defines its own CASL
ability and route requirements; a catalog admin is not an Identity admin. Check token
and subject revocation before execution. Read-during-outage is explicit metadata,
not a blanket exception for every GET. Subject erasure and administrative exports
remain privileged even when their HTTP verbs look read-only.

API keys carry explicit scopes and remain limited by their issuer's current grants.
Authenticate the environment and secret, check expiry/revocation/rotation overlap,
and recheck the active issuer. Role changes cannot widen an already-issued key.

For another module, replace the ability map and resource subjects. Keep signature and
revocation verification; receiving a role name does not grant its semantics until the
local map says so. Test another module's role, another tenant's resource identifiers,
expired keys, revocation and both sides of the Redis outage policy.

A module that does not own the signing keys verifies against the published JWKS document
instead. Three facts are then a cross-module contract rather than Identity's private
business, and Catalog is where that first mattered:

- **The issuer is `horizon-identity-<kid>`** — one issuer per signing key, because Kong
  OSS selects a credential by `iss` (ADR 0036). Bind the claim to the verified header's
  `kid`, or a token signed by a retired key replays under the active key's issuer.
- **The denylist keys are `identity:denylist:jti:<base64url>` and
  `identity:denylist:subject:<base64url>`.** Identity revokes, every module checks
  (ADR 0021). Copy the key builders; renaming them is a breaking change for every reader.
- **An unreachable key set is an outage, not a forgery.** An unknown `kid` is 401; a JWKS
  document that never arrived is 503, or a key-server incident reads as every token in the
  system being rejected as invalid.
