# Phase 71 evidence — API keys that reach modules

[Plan](ai-phase71-implementation-plan.md) ·
[Phase N plan](ai-implementation-plan.md#71--phase-n-decisions-and-api-keys-that-reach-modules) ·
[smoke record](drills/2026-09-29-phase71-api-key-smoke.json)

## What was delivered

- **ADRs 0064–0069** record the decisions of Phase N, indexed under "AI with isolation".
  The port table of the expansion plan reserves `agent` (3015) and `knowledge` (3016).
- **Contracts 0.52.0,** with every service repinned:
  - `API_KEY_SCOPES`, `apiKeyScopeSchema`, `SCOPE_ONLY_NAMES`;
  - `accessTokenScopesSchema` (the `scp` claim);
  - `apiKeyTokenResponseSchema`;
  - `scopeAllows()` and `SCOPE_REFUSAL_MESSAGE`.
- **Identity:**
  - `POST /auth/api-key/token` (`ExchangeApiKeyUseCase.forKey`) mints a 60-second token
    with `sub: api-key:<id>`, `key_issuer`, `scp` and the issuer's current roles, only in
    the modules the key reaches;
  - the fiscal token is `forFiscalReader` of the same use case: three fixed roles, the
    ordinary lifetime, and now `scp`;
  - `RedisApiKeyRateLimiter`: a fixed window per key and minute, with
    `API_KEY_EXCHANGES_PER_MINUTE` (120). Over the limit the answer is 429 with
    `Retry-After`; without Redis, 503;
  - key creation validates scopes against the published vocabulary. The scope-only names
    (`agent:connect`, `files:read`, `files:write`, `knowledge:read`) need no role.
- **Every module** reads `scp` and calls `scopeAllows` for its own name:
  - in its guard, after verification and revocation and before any role;
  - Fiscal, in its request handler.
- **Kong:** the route `identity-key-exchange` for `POST /auth/api-key/token`, with 1,200 a
  minute per IP. The agent server will exchange for every tenant from one address; the
  real limit is per key.
- **Web:** the key dialog offers read and write only in the modules the person holds a
  role in, plus the scope-only names, with a sentence saying so (pt-BR and en).

## Exit evidence

| Criterion | Proof |
|---|---|
| A `catalog:read` key cannot write to Catalog, and a key without a `sales` scope cannot read Sales, in every module, through Kong | The smoke: for each of the 14 modules, a read-scope token reads (200 in all 14) and its `POST` gets the same 403; a `catalog:read` token gets 403 on `GET /sales/contracts` |
| A revoked key fails its next exchange | The smoke, and `identity/test/http.e2e-spec.ts` |
| An issuer who loses a role takes it away from the key | The smoke: revoking the owner's Sales role turns the next exchange into 403 `scope-beyond-issuer` |
| A key over its limit gets 429 | The smoke: the 121st exchange in a minute gets 429 with `Retry-After`; the e2e also proves that a wrong secret spends nothing |

### Also proven

- **Tests:**
  - contracts: `api-keys.spec.ts`;
  - Identity: `exchange-api-key.spec.ts`, `api-key-scopes.spec.ts` (the domain's copy
    equals the published list), and two new HTTP e2e tests;
  - Catalog: an HTTP e2e test with a key token;
  - guard or handler specs in Sales, Parties and Fiscal;
  - web: `api-key-scopes.spec.ts`.
- **A write scope passes the scope check in every module.** What answers next is the
  module's own validation, for the smoke's empty body:
  - Identity answers 403 `step-up-required`, because a key token never proves a recent
    sign-in (Phase 67);
  - Catalog answers 422, Webhooks 500 (see below), and the others 400.

## Found, not fixed here

- **Webhooks answers 500 to an invalid body.** A `ZodError` in
  `POST /webhook-subscriptions` is not mapped to 400. It happens with any token, it
  predates this phase, and it is left for its own fix.
- **The verified-key cache of ADR 0022 does not exist.** Every exchange pays the Argon2id
  comparison. ADR 0064 now says so, and Phase 72 measures whether the agent needs the
  cache.
