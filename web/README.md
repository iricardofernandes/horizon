# `web/`

The Next.js frontend (App Router).

**Status: phase 1 — scaffold.** This is the blank template plus real configuration.
The application itself is phase 10; a free-tier deployment of it is phase 11.

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
- **Tenant resolution.** The tenant comes from the token, server-side. The frontend
  never sends a tenant id it chose.

---

## Endpoints consumed

None yet. The client is written in phase 10 against the OpenAPI documents aggregated
at the gateway.

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

The API it talks to is a phase 2 (platform) and phase 4 onwards (services) deliverable.
Until then the page is static.

## Environment

| Variable | Purpose |
|---|---|
| `HORIZON_API_URL` | Kong's address, used from server components and route handlers |
| `NEXT_PUBLIC_HORIZON_API_URL` | Kong's address as seen by the browser. Carries no secret |
| `NEXT_PUBLIC_OTEL_EXPORTER_OTLP_ENDPOINT` | Collector endpoint for browser spans |
| `OTEL_SERVICE_NAME` | Service name in traces |

Anything prefixed `NEXT_PUBLIC_` is compiled into the client bundle and is therefore
public. No secret may ever carry that prefix.

---

## A note on `tsconfig.json`

`next build` rewrites this file — it adds path entries and reformats it. It is therefore
**excluded from Biome** in `biome.json`, because otherwise every build would leave the
lint check failing on formatting Next had just applied. Next owns that file; we own the
rest.

