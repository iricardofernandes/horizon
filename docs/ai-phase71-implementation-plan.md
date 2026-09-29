# Phase 71 — Phase N decisions, and API keys that reach modules

Status: **delivered on 2026-09-29** ([evidence](ai-phase71-evidence.md)). This is the execution record for
[Phase 71 of the AI with isolation plan](ai-implementation-plan.md#71--phase-n-decisions-and-api-keys-that-reach-modules).
It opens Phase N of the [ERP expansion plan](erp-expansion-plan.md#phase-n--ai-with-isolation).

## Result

After this phase:
- **Phase N's decisions are recorded** as ADRs 0064–0069, before any code that assumes them.
  The module list gains `agent` (3015) and `knowledge` (3016), which have no folder yet.
- **A key reaches every module.** `POST /auth/api-key/token` exchanges a key for an access
  token that lives for 60 seconds:
  - its subject is `api-key:<id>`, and the `key_issuer` claim names the person who issued
    the key;
  - its roles are the issuer's current roles, only in the modules the key has a scope
    for;
  - the `scp` claim lists the key's scopes.
- **Every module checks the scopes.** A token carrying `scp` may:
  - read a module with `<module>:read` or `<module>:write`;
  - write to it only with `<module>:write`.

  A token without `scp`, from a signed-in person, is unchanged.
- **The fiscal token is one case of the same exchange.** It keeps its route, its three
  reader roles and its 15-minute lifetime, which the fiscal worker's cache relies on. It
  now carries `scp` like any key token.
- **Exchanges are limited per key.** A fixed window per minute in Redis applies to both
  exchange routes. Over the limit the answer is 429 with `Retry-After`. When Redis cannot
  be reached, the exchange refuses with 503 rather than skip the count.
- **The Developers key screen** offers only the scopes the issuer can grant: the modules
  they hold a role in, plus the scope-only names.

## Starting point

- API keys exist with their format, Argon2id secret, scopes and rotation (ADR 0022).
  - Scopes match `<module>:read|write` for **any** module name. An unknown module is
    refused only because no issuer holds a role there.
  - Their scopes are re-evaluated against the issuer on every use.
- `POST /auth/api-key` answers the key's id, scopes and the issuer's roles, but mints
  nothing. `POST /auth/fiscal-token` mints a token with three fixed reader roles. Nothing
  else turns a key into a token.
- **No module reads a scope.** Each verifier parses `sub`, `tenant_id`, `roles`, `jti`, `iss`,
  `iat` and `exp`, and ignores the rest.
- **Rate limits:** Kong applies a global ceiling and per-route limits. Nothing is counted
  per key.
- **The key screen** offers a fixed list of nine scopes, whatever the issuer holds.

## Decisions frozen by this plan

1. **The scope vocabulary** is published in contracts (`http/api-keys.ts`):
   - `<module>:read` and `<module>:write` for every module with roles;
   - four scope-only names: `agent:connect`, `files:read`, `files:write` and
     `knowledge:read`.

   `agent`, `files` and `knowledge` hold no roles (ADR 0060, ADR 0065, ADR 0067), so these
   scopes carry no role into a token. What they reach is still decided by the owning
   modules' roles. Any active user may put them on a key.

   `files:write` is added to the three names of the Phase N plan. Attaching a file is a
   write to `files/`, and without it no key could ever attach one.

   Identity's domain keeps its own copy of the vocabulary, since the domain does not import
   contracts (ADR 0031). An equality test in infrastructure keeps the two the same.
2. **Write implies read.** `sales:write` alone reads Sales. A key that writes a record
   must be able to read it back, and ADR 0022 made the action axis coarse on purpose.
3. **Reads and writes are decided by the HTTP method.**
   - `GET`, `HEAD` and `OPTIONS` are reads; every other method is a write.
   - A `POST` that only computes (a report preview, a reconciliation run) is therefore a
     write for a key.

   That is the conservative reading, and ADR 0064 records it. The module a request
   belongs to is the service answering it, never a path segment.
4. **The key token:**
   - `sub: api-key:<id>`, `key_issuer: <user id>`, `roles` narrowed as above, `scp`, a
     60-second lifetime and no `sid`, `amr` or `auth_time`;
   - `amr` is absent, so no route that requires recent authentication or MFA accepts
     it (Phase 67).
5. **The exchange response** is published as `apiKeyTokenResponseSchema`:
   - `tenantId`, `apiKeyId`, `accessToken`, `expiresAt` and `scopes`;
   - no roles, because the caller has no use for them and they are the issuer's.
6. **Rate limits:** one limit per key, `API_KEY_EXCHANGES_PER_MINUTE` (default 120).
   - A tier per key, which the Phase N plan named, waits until a customer needs one: it
     would add a column, an API field and a screen, for nobody yet.
   - The count is kept per key id, after the key is verified, so a stranger cannot spend
     someone else's allowance with a wrong secret. Failed guesses are Kong's global
     ceiling to limit.
7. **The refusal** is 403 with the message "The API key's scopes do not permit this
   operation", checked:
   - after the token is verified and not revoked;
   - before any role is weighed.

   A read-only key therefore gets the same answer from every module.

## Work

1. ADRs 0064–0069, indexed in `docs/adr/README.md`, with the count in `README.md`. The
   expansion plan's module list gains `agent` and `knowledge`.
2. **Contracts 0.52.0:**
   - `API_KEY_SCOPES`, `apiKeyScopeSchema`, `scopeAllows()`, `accessTokenScopesSchema` and
     `apiKeyTokenResponseSchema`;
   - registered in the schema registry;
   - published locally, with every service repinned and its lockfile refreshed.
3. **Identity:**
   - the domain vocabulary and its equality test;
   - the signer mints with an optional grant (scopes, issuer, lifetime);
   - `ExchangeApiKeyUseCase`: authenticate, count, narrow the roles, mint;
   - the fiscal token rebuilt on it;
   - `POST /auth/api-key/token`;
   - the Redis rate limiter;
   - unit and e2e tests.
4. **Every module:**
   - the verifier accepts an optional `scp` (at most 60 strings);
   - the guard calls `scopeAllows` for its own module name;
   - Fiscal's verifier takes the request method.

   Modules that already have a guard spec gain the scope cases. The others are covered by
   the smoke through Kong.
5. **Web:** the key dialog lists scopes from the session's roles and the scope-only names,
   in pt-BR and en.
6. **`scripts/phase71-smoke.mjs`,** through Kong, against the running stack:
   - it creates a read-only key and a read-write key;
   - it exchanges them;
   - it reads and writes in every module;
   - it checks the answers.

   Then it covers a revoked key, an issuer who lost a role, and a key over its limit.

## Exit evidence

- A `catalog:read` key cannot write to Catalog, and a key without a `sales` scope cannot
  read Sales, and so on for every module, through Kong.
- A revoked key fails its next exchange.
- An issuer who loses a role takes it away from the key on the next exchange.
- A key over its limit gets 429.
- `make check`, the contracts compatibility gate and the touched modules' e2e suites pass.
