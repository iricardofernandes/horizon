# Phase 80 evidence — The web and the gateway

[Plan](hardening-phase80-implementation-plan.md) · [debts and hardening](hardening-plan.md) ·
[smoke](drills/2026-09-30-phase80-web-gateway-smoke.json)

## Before and after

| | Before | After (2026-09-30) |
|---|---|---|
| Who Kong limits | the web server's address, for every browser | each browser's address. The web server is the only caller Kong believes |
| A forged `X-Forwarded-For` | — | ignored. Kong logged `10.213.80.1` (the host, as the web server saw it) for a sign-in through the web with `X-Forwarded-For: 1.2.3.4`, and `172.23.0.1` for one sent straight to Kong with `5.6.7.8` |
| Page headers | none; `X-Powered-By: Next.js` | CSP with a nonce per request, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`; no `X-Powered-By` |
| A write another site started | reached the route (only `SameSite=Lax` stood in the way) | `403` |
| Catalog items without an Inventory role | the page failed on the stock's `403` | the items, without the availability column |
| A write right after signup | `500` (the Catalog e2e reproduced it; Sales and Inventory failed on the same foreign key) | Sales and Inventory take it. Catalog answers `503` with `Retry-After: 2`, and the web and the scripts ask again |

## Proof

- **The smoke** (`node scripts/phase80-smoke.mjs`), 5 of 5:
  - **Limits per browser.** Two throwaway containers on `horizon-edge` play two browsers.
    - The first signed in wrongly 32 times: 30 refusals (`401`), then `429`.
    - The first again, with a forged `X-Forwarded-For`: `429`, `429`.
    - The second, from another address: `401`, so it was still allowed to try.
  - **Headers:** two loads of `/login` carry different nonces, and neither policy allows
    inline scripts.
  - **Cross-site writes:** `Sec-Fetch-Site: cross-site` gives `403`; a foreign `Origin` with
    no `Sec-Fetch-Site` gives `403`; the same origin reaches the route (`400`, for its empty
    body).
  - **Catalog without Inventory:** a Catalog `viewer` reads `/catalog/items` (`200`), and
    Inventory refuses `/inventory/warehouses` (`403`).
  - **Writes right after signup,** each asked once with no retry: Catalog answered `503`
    with `Retry-After: 2`, since the race was real on this run; Inventory answered `201`.
- **e2e tests that fail on the old code:**
  - Catalog: a unit created before provisioning is `503`, `Retry-After: 2`,
    `workspace-not-ready`. The old code gave `500`;
  - Sales: an order placed in a workspace not yet provisioned. The old code failed on
    `command_receipts_tenant_id_fkey`;
  - Inventory: an adjustment policy set in a workspace not yet provisioned.
- **Web unit tests** (173 in all):
  - the address the web server vouches for (hops, forged chains, mapped IPv4);
  - the policy and headers, and cross-site writes;
  - the retries;
  - a refused read;
  - a guard that every Kong call goes through `gatewayFetch`.
- **In the browser** (Playwright), in pt-BR:
  - sign-in and the app raise no CSP violation. The only console error is the favicon's
    `404`, which predates this phase;
  - a Catalog viewer without Inventory opens *Catálogo → Itens*. The columns are Item, SKU,
    Tipo, Unidade, Preço, Status and Ações, with no *Disponível*. The console shows the
    expected `403` for the stock.
- **`make test-phase10`** (the browser golden path) passes under the new policy.

## Found and fixed in this phase

- **The web server's own and Kong's addresses collided** on the first start. Kong started
  first and took `.2`, the address meant for the web server. Both now have fixed addresses.
- **A rate-limited sign-in read "check your email and password".** It now says there were too
  many attempts from this address, in both languages, and passes `Retry-After` on.
- **`headers()` in `next.config.ts` is evaluated when the image is built,** so HSTS could not
  depend on `HORIZON_COOKIE_SECURE` there. HSTS is set per request in `src/proxy.ts`.

## Not done, stated

- **Style attributes stay allowed** (`style-src-attr 'unsafe-inline'`). React and Radix set
  them, and a nonce cannot cover an attribute. Scripts get no such allowance.
- **Behind a load balancer**, `HORIZON_WEB_TRUSTED_HOPS` must be set to the number of proxies
  that append the address they saw. If the web server is also reachable without passing
  through them, a browser could name its own address. This is a deployment setting, and it is
  stated in the compose file.
- **The limit on `/auth` stays 30 a minute per address.** An office behind one NAT address
  still shares it. That is the address's limit, not the web server's any more.

## Verification (2026-09-30)

- `node scripts/ci-local.mjs --full` passed: typecheck, lint, unit and e2e of every module,
  clean installs, generated contracts and every Docker image.
- After rebuilding the stack: `make demo` twice, `make test-alerts`, `make test-phase10` and
  the smoke all passed. Every DLQ still holds 0 messages.
- `deck` was not run, since `gateway/kong.yml` did not change. Kong's new settings are
  environment variables in `infra/docker-compose.yml`.
