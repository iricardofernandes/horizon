# Debts and hardening — Phases 79 to 81

Status: **in progress**. Before choosing Phase O's theme, this plan pays the debts and
hardens what Phases A to N left open. It holds only the items still true when checked on
2026-09-29, each with its evidence. The Anthropic adapter's run against the real API stays
out, by the owner's decision.

## What was found

| # | Debt | Evidence on 2026-09-29 | Phase |
|---|---|---|---|
| 1 | **Every dead letter is copied into every dead-letter queue.** All 15 consumers bind their `<queue>.dlq` to `horizon.events.dlx` with `#` (Fiscal with a list of types). | ~9,000 identical messages in almost every DLQ, 1,340 even in `knowledge.documents.dlq`. Nobody can tell which consumer refused an event | 79 |
| 2 | **`webhooks` refuses every event of a workspace it never provisioned.** Its inbox has a foreign key to `tenants`, and nothing calls `provisionTenant`. | The code; the Phase 57 note ("~800 old rejections"); `webhooks.events.dlq` | 79 |
| 3 | `webhooks` records every event's source as `sales`. | `recordEvent` | 79 |
| 4 | `webhooks` answers `500` to an invalid body. | The Phase 71 note: a `ZodError` with no filter | 79 |
| 5 | `webhooks` exports no inbox metrics, so its dead letters are invisible to the Phase 70 SLI. | No `inbox_*` series with `service_name="webhooks"` | 79 |
| 6 | **A producer seals only tenants with outbox rows,** so a workspace without events from a source never gets that source's watermark. | `sealAllTenants` in 7 modules; open in the Phase M threat model | 79 |
| 7 | **Kong's per-address limits count every browser as one.** The web server calls Kong for all of them, so `/auth` (30 a minute) and the global 600 a minute are shared. | Phase 78: one screen's loop spent the limit for every screen | 80 |
| 8 | **The web sends no security headers.** There is no CSP, no `frame-ancestors`, no `nosniff`, and no Referrer-Policy. Mutating API calls rely on `SameSite=Lax` alone. | `curl -I /login`; `web/src` | 80 |
| 9 | Catalog's items screen fails without an Inventory role. | Phase 77 | 80 |
| 10 | A write in a module that has not yet received the workspace's provisioning event answers `500`. | Phase 77 smoke: `POST /catalog/units` → `500` right after signup | 80 |
| 11 | **The master keys cannot be rotated** (`KNOWLEDGE_MASTER_KEY`, `ASSISTANT_MASTER_KEY`). | Phase N threat model, open | 81 |
| 12 | A stolen key's unusual use raises no alert. | Phase N threat model, open | 81 |
| 13 | Inventory's branch coverage is under its own gate (71% < 80%). | `npm run test:cov` in `inventory/` | 81 |
| 14 | The golden path's image builds fail at random (`ETXTBSY`, `SIGBUS`) when a dozen `npm ci` run at once. | CI on 2026-09-29; the Phase L note | 81 |
| 15 | **Dependabot fails for every project:** it cannot reach `@horizon/contracts` on `localhost:4873`. | Every `npm_and_yarn` run on 2026-09-29 | 81 |

Left out, with their reasons:
- **Alert delivery** (Alertmanager, a pager) and **backup key custody** belong to the
  deployment owner.
- **The services scheduler** and **per-contact redaction in CRM** are features, not debts.

## Phase 79 — Messaging: dead letters of their own, and webhooks that deliver

**Delivered on 2026-09-30** ([plan](hardening-phase79-implementation-plan.md),
[evidence](hardening-phase79-evidence.md)). Dead letters are routed by the queue they died
in rather than re-declared, which revised item 1 below; and emptying the DLQs found four
more defects, all fixed.

1. **Each queue's dead letters go to its own DLQ.**
   - Every consumer declares its queue with `x-dead-letter-routing-key: <queue>`, and binds
     `<queue>.dlq` to the dead-letter exchange with that key only.
   - Declared arguments cannot change on a live queue. `scripts/migrate-dead-letters.mjs`
     moves a broker, with consumers stopped:
     - it deletes each empty queue declared the old way, so its consumer declares it again
       at start, and refuses one that still holds messages;
     - it removes the `#` bindings;
     - with `--purge-copies`, it empties the DLQs of the copies made by the old binding.
2. **`webhooks`:**
   - the tenant is provisioned in the transaction of its first event or subscription;
   - the inbox records the producing module;
   - an invalid body is `400`;
   - `inbox_consumed_total` and `inbox_dead_lettered_total` are exported, as in the other
     consumers.
3. **Seals for every known tenant.** The seven producers seal every tenant in their
   `tenants` table, with a count of 0 when it has no rows. The relay role reads
   `tenants.id`.
4. **Proof:**
   - e2e in the changed consumers;
   - a smoke that dead-letters one event in one consumer and finds it in that consumer's
     DLQ only;
   - a fresh workspace's webhook delivered;
   - a source without events sealed.

## Phase 80 — The web and the gateway

1. **Limits per browser.**
   - The web server forwards the browser's address in `X-Forwarded-For`.
   - Kong reads it (`real_ip_header`, `trusted_ips` set to the web server's network), so
     its per-address limits apply per person's address again.
   - An address outside the trusted network is still limited by its own address.
2. **Security headers** on every web response:
   - a Content-Security-Policy with no inline scripts allowed beyond Next's nonce;
   - `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, and
     `Referrer-Policy: strict-origin-when-cross-origin`;
   - HSTS when served over HTTPS.

   A mutating request to the web's own API routes must come from the same origin
   (`Origin` or `Sec-Fetch-Site`), or it is `403`.
3. **Catalog's items screen** reads warehouses only with an Inventory role, and works
   without them.
4. **Writes before provisioning** answer `503` with `Retry-After`, not `500`, in every
   module that provisions from Identity's event. The web and the scripts retry them.

## Phase 81 — Keys, alerts and quality

1. **Master key rotation for `knowledge/` and `agent/`.**
   - Each accepts a list of master keys, the first one current.
   - A wrapped key names the master key version that wrapped it.
   - A background re-wrap moves every document and person key to the current version,
     and reports when none is left on an old one.
   - Old master keys can then be removed.
2. **Unusual key use:** Identity counts refused and rate-limited exchanges
   (`identity_api_key_exchanges_total{outcome}`) with no key label. `ApiKeyExchangesRefused`
   fires on a burst, and the log names the key.
3. **Inventory's coverage** back over its gate, with unit tests for the purchase receipt
   and the procurement consumer.
4. **Builds:** the golden path workflow and `make up-apps` build images a few at a time.
5. **Dependabot** stops failing: `@horizon/contracts` is ignored in every entry, since it
   is updated by our own release flow, and its registry is declared as not reachable.
   Whether that is enough is proven only by Dependabot's next run, and is stated so.

## How each phase closes

As agreed: a plan and evidence per phase, one local commit each, and the usual runs
(`ci-local --full`, `make demo` twice, `make test-phase10`, `make test-alerts`, deck when
`kong.yml` changes). There is no push without being asked.
