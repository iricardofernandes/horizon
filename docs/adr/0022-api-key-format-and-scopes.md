# 22. API key format and scope model

- Status: accepted
- Date: 2026-09-07

## Context

Third parties integrate with an ERP: an e-commerce front end reading the catalog, a
logistics provider updating shipments, a tenant's own scripts. Issuing them JWTs is
wrong — JWTs are short-lived by design and a machine integration has no interactive
refresh — and issuing them a user's password is worse.

An API key is a bearer credential with no expiry, which makes three properties
essential: it must be identifiable without being usable, it must be independently
revocable, and it must never grant more than the person who created it could grant.

## Decision

**Format:** `hz_<env>_<24-char public prefix>_<32-char secret>`

- `hz_` makes the string recognisable in a log, a paste, or a secret scanner.
- `<env>` (`live`, `test`, `dev`) prevents the classic incident of a test key reaching
  production or the reverse.
- The **24-character prefix is stored in plaintext and indexed**. Lookup is a single
  indexed equality on the prefix; only then is the secret verified.
- The **32-character secret is stored as an Argon2id hash** (ADR 0019) and never
  stored, logged or displayed after creation.

**Scopes:** every key carries an explicit list of scopes — `catalog:read`,
`sales:write` — and the list is **always a subset of what the issuing user can
grant**. A user cannot mint a key more powerful than themselves. This is checked at
creation against the user's own permissions (ADR 0023), not merely documented.

**Operations:** the key is shown **once**, at creation. Rotation issues a new key with
the same scopes and a configurable overlap during which both work. Revocation is
immediate.

**Rate limits** are per key, enforced at Kong via the key's consumer group; usage
counters live in Redis. `last_used_at` is written **at most once per minute** per key.

## Consequences

- The prefix makes lookup O(1) on an index without the secret ever being searchable,
  and it lets a leaked key be identified from a log line and revoked without the
  holder producing it.
- Argon2id on the secret costs ~19 MiB per verification, which is heavy for a
  machine-to-machine path called continuously. Mitigated by a short-lived
  verified-key cache in Redis keyed by the prefix and a fast digest of the presented
  secret, so the Argon2id cost is paid on cache miss, not per request. The cache
  entry is invalidated on revocation.
- The subset rule means revoking a user's permission does not automatically narrow
  keys they already issued. Keys are therefore re-evaluated against the issuer's
  current permissions on use, and a key whose scopes exceed its issuer's current
  grants is rejected and flagged.
- `last_used_at` throttling keeps a hot key from turning every request into a write.
  The value is accurate to a minute, which is what it is used for.
- Keys do not expire by default. An optional expiry is available and recommended in
  the documentation; forcing one would break integrations that have no rotation story.

## Alternatives considered

**Hash the whole key and look it up by hash.** Simpler storage. Rejected: it forbids a
slow hash (you cannot index an Argon2id output), so it forces a fast digest, and it
makes identifying a leaked key impossible without the full secret.

**JWTs for machine clients.** Rejected: no interactive refresh path, and revocation
returns to the denylist problem for a credential that should be independently
revocable.

**OAuth2 client credentials.** The correct answer at larger scale, and the natural
successor. Rejected for now as substantially more surface — a token endpoint, client
registration, a second token type — for a benefit that the scope model already
delivers.

**mTLS.** Strong, and impractical for the tenant-writes-a-script use case.
