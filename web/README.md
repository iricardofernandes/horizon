# `web/`

The Next.js frontend (App Router).

**Status: phase 10 — complete.** The portal authenticates against Identity and exposes
the operational golden path through a server-side BFF. A free-tier deployment is phase 11.

---

## What this project owns

- **Presentation.** Screens, navigation, forms, and the client-side session.
- **Its own view models.** Data arrives as API payloads and is shaped for display here.

## What it explicitly does not own

- **Business rules.** Every invariant is enforced server-side. The frontend may
  duplicate a validation for a better experience, never as the only check.
- **Direct access to any service.** Everything goes through Kong, so the frontend
  inherits authentication, rate limiting, CORS and trace propagation from the gateway
  rather than reimplementing them (ADR 0008).
- **Token minting or verification.** It holds a session and refreshes it; `identity/`
  decides.
- **Tenant authority.** Login first receives an allowlisted workspace projection. The
  selected tenant is validated server-side before Identity puts it in a token; browser
  headers never establish tenant authority.

---

## Surface and endpoints

| Screen | Kong routes consumed |
|---|---|
| Session | `POST /auth/login`, `POST /auth/workspaces`, `POST /auth/workspace`, `POST /auth/refresh`, `POST /auth/logout`, `GET /identity/me` |
| Overview/catalog | `GET /catalog/items`, `GET /catalog/price-lists`, `GET /inventory/warehouses` |
| Customers | `GET/POST/DELETE /sales/customers` |
| Quotes | `GET/POST /sales/quotes`, `GET /sales/quotes/:id`, `POST /sales/quotes/:id/accept` |
| Orders | `GET/POST /sales/orders`, `GET /sales/orders/:id`, `GET /sales/customers` |
| Inventory | `GET/POST/PATCH /inventory/warehouses`, `POST /inventory/stock-receipts` |
| Access | `GET/POST/PATCH /identity/users`, `POST /identity/users/:id/roles` |
| Webhooks | `GET/POST/DELETE /webhooks/webhook-subscriptions`, `GET /webhooks/webhook-deliveries` |

The browser calls only `/api/session` and the allowlisted `/api/horizon/*` BFF. Access,
refresh, family and tenant values stay in `HttpOnly`, `SameSite=Lax` cookies; the BFF
rotates an expired access token before retrying once. The tenant id is derived from the
Identity token and is never accepted from a browser-controlled header.

---

## Local development

```bash
npm install
cp .env.example .env.local

npm run typecheck
npm run lint
npm test
npm run dev          # http://localhost:3000
```

From the repository root, the fully integrated path is:

```bash
make up
make demo
make up-apps
make test-phase10
```

Sign in as `demo@horizon.local` with the local-only password `Horizon-demo-2026!`, then
select the `horizon-demo` workspace.

`make test-phase10` drives the production build in the system Chromium: it signs in,
selects and switches workspace, exercises Catalog, Customers, Quotes, Inventory, Orders,
Webhooks, Access and Settings, places an order, waits for Inventory confirmation, creates
and removes a temporary webhook subscription, checks every screen for document overflow
at 390 px, and requires one Jaeger trace containing `web`, `gateway`, `sales`, `inventory`
and `webhooks`.

## Accessibility baseline

The phase 10 baseline is WCAG 2.2 AA for the delivered screens: semantic landmarks and
headings, programmatic form labels, keyboard-operable navigation/forms, visible focus,
status/error announcements, no motion-dependent interaction, and no document-level
horizontal overflow from 390 px upward. Tables retain their own bounded horizontal scroll
when their columns cannot fit. The browser golden-path test continuously asserts the
mobile overflow and the accessible labels used for its interactions.

## Design system foundation

All interface typography uses the self-hosted variable Inter font with `Inter,
sans-serif` fallbacks. Phosphor is the only interface icon set. Interactive primitives
are composed from Base UI in `src/components/ui`; feature screens should consume those
components instead of styling raw buttons, inputs, selects, dialogs, menus, or overlays.

Colors come from Radix Colors. Sage supplies the neutral scale, Jade the accent and
positive scale, Amber warnings, and Red errors or destructive states. Screens use the
semantic aliases declared in `src/app/styles.css`, not literal palette values. The
rationale and extension rules are recorded in
[ADR 0039](../docs/adr/0039-frontend-design-system-foundation.md).

## Environment

| Variable | Purpose |
|---|---|
| `HORIZON_API_URL` | Kong's address, used from server components and route handlers |
| `HORIZON_COOKIE_SECURE` | Enables `Secure` on session cookies; required behind HTTPS |
| `NEXT_PUBLIC_HORIZON_API_URL` | Kong's address as seen by the browser. Carries no secret |
| `NEXT_PUBLIC_OTEL_EXPORTER_OTLP_ENDPOINT` | Collector endpoint for browser spans |
| `OTEL_SERVICE_NAME` | Service name in traces |

Anything prefixed `NEXT_PUBLIC_` is compiled into the client bundle and is therefore
public. No secret may ever carry that prefix.

Browser spans are sent straight to the Collector and their W3C `traceparent` is forwarded
by the BFF. Kong extracts and reinjects that context; backend HTTP and RabbitMQ spans then
remain in the same trace.

## Public deployment profile

Phase 11 includes an explicitly reduced Vercel + Neon profile. With
`HORIZON_HOSTED_DEMO=true`, the route handlers provide a signed HttpOnly demo session and
read the seeded Catalog from Neon; Orders and Webhooks are hidden because the public
profile does not run their services or RabbitMQ. The full provisioning and disclosure are
in [`docs/deployments/vercel-neon.md`](../docs/deployments/vercel-neon.md).

---

## A note on `tsconfig.json`

`next build` rewrites this file — it adds path entries and reformats it. It is therefore
**excluded from Biome** in `biome.json`, because otherwise every build would leave the
lint check failing on formatting Next had just applied. Next owns that file; we own the
rest.
