# 20. Opaque, rotating refresh tokens with reuse detection

- Status: accepted
- Date: 2026-09-07

## Context

Access tokens live 15 minutes and are not revocable in themselves; a refresh token
lives for days or weeks and is therefore the credential worth stealing. The design
question is not how to make theft impossible but how to make it **detectable**.

A long-lived, non-rotating refresh token gives an attacker who obtains it the same
access as the legitimate user, for its full lifetime, with no signal that anything
happened.

## Decision

Refresh tokens are **opaque high-entropy random strings** — not JWTs, not UUIDs —
stored **hashed** in Redis and keyed by **family**. A family is created at login and
represents one device's session.

- **Rotation on every use.** Presenting a refresh token invalidates it and issues a
  new one in the same family.
- **Reuse detection.** Presenting an already-rotated token means two parties hold
  tokens from the same family, which means one of them is an attacker. The response is
  to invalidate **the entire family** — logging out both the attacker and the
  legitimate user — and emit a security audit event (ADR 0025).
- **Two independent lifetimes**, both configurable: an absolute maximum from family
  creation, and an idle timeout since last use.

## Consequences

- A stolen refresh token is usable exactly once before the theft becomes visible.
  Whichever party refreshes second triggers the alarm; either way the family dies and
  the legitimate user is prompted to authenticate again. A forced re-login is a far
  better outcome than an undetected persistent session.
- Because the tokens are opaque, they carry no claims and can be revoked
  unilaterally — the entire reason not to use a JWT here.
- Because they are hashed at rest, a Redis compromise does not yield usable tokens.
  Hashing is a fast digest, not Argon2id: these are high-entropy random strings, not
  passwords, so there is no dictionary to attack and no reason to pay the cost.
- Redis becomes a hard dependency of the refresh path. Redis unavailable means no
  refresh, which means sessions expire within 15 minutes of the outage. Accepted:
  failing closed on session extension is the correct direction, and it is a different
  decision from the denylist's asymmetric behaviour (ADR 0021), which concerns tokens
  already issued.
- A legitimate user with two tabs racing a refresh can trigger a false positive. A
  short grace window on the immediately-previous token — during which the same
  replacement is returned rather than a new one — handles the race without weakening
  detection.
- They are **not** UUIDv7 (ADR 0009): a UUIDv7 encodes its creation time and has less
  entropy than a purpose-generated random string.

## Alternatives considered

**A long-lived JWT as the refresh token.** Stateless and revocation-free, which is the
problem: it cannot be revoked at all.

**Rotation without reuse detection.** Rotation alone limits the window but produces no
signal, and the attacker who refreshes first simply keeps the session while the user
is silently locked out with no explanation.

**No rotation, short lifetime.** Trades user experience for a smaller window and still
provides no detection.
