# 64. API keys reach modules through short tokens that carry their scopes

- Status: accepted; implemented in Phase 71 ([plan](../ai-phase71-implementation-plan.md)).
  Extends ADR 0022.
- Date: 2026-09-29

## Context

ADR 0022 gave API keys a format, a slow hash and a scope list that is a subset of what the
issuer can grant. Only half of it was built:
- Identity verifies a key and re-evaluates it against the issuer on every use.
- Only one route, `POST /auth/fiscal-token`, turns a key into something a module accepts,
  and it grants three fixed reader roles.
- No module reads a scope. A token minted from a `catalog:read` key would be allowed any
  write its roles allow.
- The per-key rate limit was never configured.

Phase N puts a tenant's own agent in front of every module (ADR 0065). The agent has to
reach them with the key's authority and nothing more.

## Decision

1. **The exchange.** `POST /auth/api-key/token` verifies a key and mints an access token
   that lives for **60 seconds**:
   - its subject is `api-key:<id>`, and `key_issuer` names the issuer;
   - its roles are the issuer's **current** roles, only in modules the key has a scope for;
   - `scp` lists the key's scopes;
   - it carries no `sid`, `amr` or `auth_time`, so no route that requires MFA or recent
     authentication accepts it.

   A caller exchanges before each request, or at most once a minute. Revocation therefore
   takes effect on the next exchange. Each exchange pays the Argon2id comparison: the
   verified-key cache that ADR 0022 describes does not exist yet, and whoever adds it must
   invalidate it on revocation.
2. **Every module checks the scopes itself.**
   - A token with `scp` may read a module with `<module>:read` or `<module>:write`, and
     write to it only with `<module>:write`. Write implies read.
   - Read and write are decided by the HTTP method: `GET`, `HEAD` and `OPTIONS` read;
     everything else writes, including a `POST` that only computes.
   - The module is the service answering, never a path segment.
   - The check runs after the token is verified and not revoked, and before any role is
     weighed, so a read-only key gets the same refusal everywhere.

   The rule is one function in `@horizon/contracts`, `scopeAllows`, called by each module's
   guard. A token without `scp` (a signed-in person) is unchanged.
3. **The vocabulary** is published:
   - `<module>:read|write` for every module with roles;
   - the scope-only names `agent:connect`, `files:read`, `files:write` and
     `knowledge:read`.

   Modules without roles carry no role into the token. Any active user may put a
   scope-only name on a key, because what it reaches is still decided by the owning
   modules' roles.
4. **Rate limits** are counted per key id, in Redis, in a fixed window per minute, on both
   exchange routes.
   - The count is taken after the key is verified, so a wrong secret spends nobody's
     allowance. Failed guesses fall under Kong's global ceiling.
   - Over the limit the answer is 429 with `Retry-After`.
   - When Redis is unreachable the exchange refuses with 503. It never skips the count.
5. **The fiscal token** becomes one case of the same exchange. It keeps:
   - its route and its three reader roles;
   - its 15-minute lifetime, which the fiscal worker caches;

   and it now carries `scp`.

## Consequences

- A key's authority is the intersection of its scopes and its issuer's current roles, and
  every module enforces the scope half without calling Identity.
- A `POST` search or preview needs a write scope. That is stricter than necessary, and it
  is the reading that can never let a write through a read scope.
- Kong still cannot count per key: it sees a JWT, not the key. Counting at the exchange is
  exact because nothing reaches a module without one.
- One limit applies per deployment. A tier per key waits until a customer needs one.

## Alternatives considered

**Enforce scopes at Kong.** One place instead of fourteen. Rejected: a request that reaches
a module's port directly would bypass it, and ADR 0008 makes every module verify its own
tokens for exactly that reason.

**Per-route scope annotations.** Precise (`sales:quote:create`). Rejected for now: it is
the fine-grained permission model ADR 0023 keeps inside modules, and it would put every
module's permission list in contracts.

**Keep the issuer's full roles in the token and filter at the module.** Rejected: a
module would then trust a token that claims roles the key was never meant to carry.

**Long-lived key tokens.** Rejected: revocation would wait for expiry, which is the
denylist problem ADR 0022 avoided for keys.
