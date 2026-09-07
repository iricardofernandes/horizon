# 19. Argon2id via `@node-rs/argon2`

- Status: accepted
- Date: 2026-09-07

## Context

Password hashes are the asset an attacker takes from a database breach. The hashing
function's job is to make offline cracking expensive, and expense today means being
hard to accelerate on a GPU — which means being memory-hard. bcrypt is not
memory-hard; its 4 KiB working set fits in GPU cache thousands of times over. It also silently
truncates input at 72 bytes, which quietly caps the strength of a long passphrase.

A second constraint is the build. Horizon's runtime images are `node:24-alpine`
multi-stage builds. Native modules that require `node-gyp` need Python and a full
toolchain in the build stage, and musl-vs-glibc mismatches are a recurring source of
"works locally, fails in the image".

## Decision

**Argon2id**, via **`@node-rs/argon2`** — a Rust binding distributed as prebuilt
platform binaries, including musl. No `node-gyp`, no Python, no compiler in the image.

Parameters at or above the OWASP minimum: **`m = 19456 KiB`, `t = 2`, `p = 1`**.

Parameters are embedded in the encoded hash string. On a successful login, if the
stored hash's parameters are below current policy, the password is **transparently
rehashed** with current parameters inside the same request — the user notices nothing
and the corpus upgrades itself as people log in.

**Peppering is out of scope.** A pepper is a secret added to the hash input and held
outside the database, so a database-only breach yields uncrackable hashes. It is
genuinely valuable, and it is declined here for one reason: rotating a pepper requires
re-hashing every password, which cannot be done without the plaintexts, so the rotation
story is "never rotate" or "rehash-on-login over an unbounded window with two peppers
live". Implementing the storage without the rotation path would be security theatre.
If it is added later it will be as an AWS KMS-backed HMAC applied before hashing, with
the dual-pepper rotation window designed first.

## Consequences

- Argon2id resists both GPU parallelism (memory-hard) and side-channel attacks (the
  `id` variant is the hybrid recommended by RFC 9106).
- Each verification allocates 19 MiB. At concurrency this is real memory pressure, and
  it is also a denial-of-service surface: an unauthenticated endpoint that hashes is a
  memory amplifier. Login is therefore rate-limited at Kong per IP and per account
  before it reaches the hasher.
- No truncation; the full passphrase contributes.
- Parameters can be raised later without a migration, because the hash carries its own
  parameters and rehash-on-login upgrades the corpus.
- The same function and the same parameters hash API key secrets (ADR 0022).

## Alternatives considered

**bcrypt (`bcryptjs`).** Rejected: not memory-hard, 72-byte truncation, and the pure-JS
implementation is slow in a way that costs the defender more than the attacker.

**bcrypt (native).** Removes the speed objection, keeps the others, and reintroduces
`node-gyp`.

**scrypt (`node:crypto` built-in).** Memory-hard, zero dependencies, and a legitimate
choice. Rejected narrowly: Argon2id is the current recommendation (RFC 9106, OWASP),
its parameter encoding in the hash string makes the rehash-on-login policy trivial,
and scrypt's built-in API has no such encoded format.

**`argon2` (the node-gyp binding).** Same algorithm, worse build story on Alpine.
