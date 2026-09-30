# Phase 80 — The web and the gateway

Status: **delivered on 2026-09-30** ([evidence](hardening-phase80-evidence.md)). The second of
the [debts and hardening](hardening-plan.md) phases.

## Result

- **Kong limits each browser by its own address,** not every browser as the web server's.
  A forged `X-Forwarded-For` does not change the address Kong counts.
- **Every web page has a content security policy** with a fresh nonce, and every response
  forbids sniffing and framing. A write to the web's API that another site started is `403`.
- **Catalog's items screen works without an Inventory role;** it shows the items without
  their availability.
- **A write right after signup is never a `500`.** Sales and Inventory take it. Catalog, which
  still has to create the workspace's default units and price list, answers `503` with
  `Retry-After`. The web and the scripts wait and ask again.

## Starting point (checked on 2026-09-30)

- The web server called Kong for every browser, so `/auth` (30 a minute) and the global
  limit (600 a minute) were shared by all of them. Phase 78 saw one screen's loop break every
  other screen with `429`.
- `curl -I /login`: no `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`
  or `Referrer-Policy`, and `X-Powered-By: Next.js`. Writes relied on `SameSite=Lax` alone.
- The items page read `/inventory/warehouses` with every load, and a `403` failed the page.
- `POST /catalog/units` for a workspace Catalog had not yet provisioned: `500` (the e2e
  reproduces it). Sales and Inventory refused writes the same way, on the `tenants` foreign
  key.

## Decisions

1. **The browser's address comes from the web server, and Kong believes only the web server.**
   - Next keeps an `X-Forwarded-For` the browser sent, so the header cannot be passed on as
     it arrives. `web/trusted-address.cjs`, preloaded with `node --require`, sets it from the
     socket before Next reads the request. `HORIZON_WEB_TRUSTED_HOPS` counts the proxies in
     front that append the address they saw (0 locally).
   - Every call from the web server to Kong goes through `gatewayFetch`, which forwards that
     address. A web test forbids any other.
   - Kong trusts `X-Forwarded-For` only from the web server's address
     (`KONG_TRUSTED_IPS`, `KONG_REAL_IP_HEADER`). Every other caller is limited by its own
     connection.
   - The web server and Kong share a network of their own (`horizon-edge`) with **fixed
     addresses** (web `.6`, Kong `.5`). No other container can take the trusted address. Host
     traffic arrives from the network's gateway (`.1`), which is not trusted. The web server
     leaves the shared network, since it only ever talks to Kong (ADR 0008).
2. **Headers:**
   - the content security policy has a nonce per request and `'strict-dynamic'`, and no
     `unsafe-inline` for scripts. `style` attributes are allowed through `style-src-attr`,
     because React and Radix set them and they carry no nonce;
   - HSTS and `upgrade-insecure-requests` are sent only when served over HTTPS
     (`HORIZON_COOKIE_SECURE`). Locally they would break the trace exporter at
     `http://localhost:4318`;
   - the fixed headers (`nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`,
     `Permissions-Policy`) are set in `next.config.ts` for every response. The rest are set in
     `src/proxy.ts`, which runs per request.
3. **Cross-site writes:**
   - a write to `/api/*` with `Sec-Fetch-Site` other than `same-origin` or `none`, or without
     it and with an `Origin` of another host, is `403`;
   - a request with neither header is not a browser's, so it is no forgery, and it passes.
4. **Items without Inventory:**
   - `readJsonIfAllowed` returns `null` on `403`;
   - the items table hides the availability column when the stock was not readable.
5. **Writes before provisioning:**
   - in Sales and Inventory, provisioning is only the `tenants` row. The tenant transaction now
     records it, as the other five modules already did, and Phase 79's insert in `processEvent`
     goes;
   - Catalog's provisioning also creates default units and a price list, so a write that
     arrives first is told to wait. The `tenants` foreign-key violation maps to
     `503 workspace-not-ready` with `Retry-After: 2`;
   - the web's API proxy asks again up to four times, for reads and for writes carrying an
     idempotency key. `scripts/phase-n-kit.mjs` does the same.
6. **A limited sign-in says so.** The login screen showed "check your email and password" on
   `429`. It now says there were too many attempts from this address.

## Proof

- **Unit tests:**
  - web (`trusted-address.spec.ts`): the address the web server vouches for;
  - web (`edge-policy.spec.ts`): the policy and headers, and cross-site writes;
  - web (`not-ready.spec.ts`): the retries;
  - web (`api.spec.ts`): a refused read;
  - web (`gateway.spec.ts`): no Kong call outside `gatewayFetch`.
- **e2e tests that fail on the old code:**
  - Catalog: `503` with `Retry-After` before provisioning;
  - Sales and Inventory: a write in a workspace not yet provisioned.
- **`scripts/phase80-smoke.mjs`:**
  - two browsers at two addresses: one spends the sign-in limit and the other is untouched,
    and forging `X-Forwarded-For` buys nothing;
  - the headers, and the nonce is fresh per page;
  - cross-site writes are `403`;
  - Catalog without Inventory;
  - writes right after signup are never `500`.
- **In the browser:** no CSP violation on sign-in or in the app; the items screen for a
  Catalog viewer without Inventory.
