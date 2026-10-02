# Security and logic review — Phases 90 to 92

Status: **proposed on 2026-10-02, not started.** A review of the whole repository for
security flaws and logic errors, after Phase O closed. It lists only what was confirmed
against the code or the running stack on 2026-10-02, each with its evidence. It also lists
what was checked and found sound, so the next review can start where this one stopped.

## What was found

Severity is the impact if exploited, weighed by what an attacker needs first.

| # | Finding | Evidence on 2026-10-02 | Severity | Phase |
|---|---|---|---|---|
| 1 | **Any service can speak for any module, for any tenant, on the event bus.** All sixteen services connect to RabbitMQ as one user, `horizon`, tagged `administrator`, with no topic permissions. Consumers apply an event in the tenant its envelope names. A compromised service, including the Agent, which by design has "no privileged path" (ADR 0065), could publish `financial.settlement.recorded` for any workspace and the Treasury and the Ledger would post it. | `rabbitmqctl list_users` shows one user; `list_topic_permissions` is empty; `RABBITMQ_URL: amqp://horizon:horizon@…` for every service in `infra/docker-compose.apps.yml`; one `mq.url_secret_arn` for every task in `infra/terraform/main.tf` | High | 90 |
| 2 | **Webhooks can be pointed at the internal network (SSRF).** An endpoint over `http` is accepted for `localhost`, `127.0.0.1` and `::1` in every environment. An endpoint over `https` is accepted for any host, including private addresses and names that resolve to them. The attempt log returns each attempt's status and duration to the workspace admin, which makes it a port-scanning oracle. | `webhooks/src/domain/webhook.ts:37`; `fetch-webhook-client.ts` resolves at connect time with no address check | Medium | 90 |
| 3 | **Tax postings do not follow the authority's answer.** Fiscal locks a document's taxes when it is validated, before it is sent to the authority, and the Ledger posts that lock. Nothing reverses the posting when the authority rejects or the issuer cancels. A correction of a rejected document comes from a new origin, so its lock posts again: **the taxes are counted twice.** | `fiscal/src/calculations.ts:238` (event at lock); `ledger/src/application/consume-module-events.ts:61–88` (only `fiscal.calculation.locked`, keyed by origin); `fiscal/src/documents.ts` successor of a rejected document; the corrected origin has a new id (`fiscal/test/ingress.e2e-spec.ts:2544`) | Medium–High | 91 |
| 4 | **A tax estimate is whatever the browser sends.** Sales and Procurement keep an estimate the web relays from Fiscal, after only a schema check. In Procurement it replaces the order's tax, is shown to the approver as Fiscal's, and is projected into Fiscal as "Fiscal's own estimate". There it is the expected value a supplier's NF-e is compared with. A buyer can make an overcharged supplier invoice reconcile "clean". | `sales/src/infrastructure/http/sales.controller.ts` `recordTaxEstimate`; `procurement/src/domain/entities/purchase-order.ts:274`; `fiscal/src/purchase-projections.ts:40`; `fiscal/src/inbound-matching.ts:95` | Medium | 91 |
| 5 | **A revised draft quote keeps its old tax estimate.** A draft is revised in place under the same id, and nothing removes the estimate, which is then carried to the order. A sent quote's estimate can also be replaced after the customer saw it. The web never compares the kept `inputDigest` with the document. Procurement clears it on revision; Sales does not. | `sales/src/application/use-cases/manage-quotes.ts:190`; `sales-database.ts:375` (open statuses `draft`, `pending`, `sent`); `web/src/features/fiscal/tax-estimate-panel.tsx` | Low–Medium | 91 |
| 6 | **"Today" is the UTC date, not the workspace's.** ADR 0043 says overdue "is a comparison of calendar dates in the workspace's timezone". From 21:00 to midnight in Brasília: titles due today read as overdue in Financial; lots expiring today stop being reservable in Inventory; report and as-of defaults move to tomorrow. Identity publishes each tenant's timezone in `identity.tenant.created`, and no module keeps it. | `financial/src/infrastructure/http/titles.controller.ts:80`; `inventory/src/domain/value-objects/tracking.ts:103`; `today()` in the command contexts of Inventory, Treasury and Ledger; Fiscal's NFS-e competence default; only `fiscal/src/inbound-imports.ts:389` subtracts three hours | Medium–Low | 92 |
| 7 | **The local stack listens on every interface with default or no credentials.** This includes Kong's Admin API on `0.0.0.0:8001`, which in DB-less mode still accepts `POST /config` and can replace every route. Also exposed: Redis with no password (the token denylist), RabbitMQ as an administrator, PostgreSQL, Grafana `admin/admin`, Loki, Prometheus and the Collector. Anyone on the same network as a developer's machine can reach them. | `infra/docker-compose.yml:452,457`; `docker port` for every `horizon-*` container | Medium (dev) | 92 |
| 8 | **The AWS stack would collapse every client into one address, and could not reach Kong.** It has no `KONG_TRUSTED_IPS`/`KONG_REAL_IP_HEADER` and no `HORIZON_WEB_TRUSTED_HOPS`, so the login limit (30 a minute) would be shared by everyone. There is no `HORIZON_COOKIE_SECURE`, so cookies would go out without `Secure` and with no HSTS. The web is given `HORIZON_UPSTREAM_URL`, but it reads `HORIZON_API_URL`, so it would call `localhost:8000`. The synthetic probe and the retention job are not deployed. | `infra/terraform/main.tf:235`; `web/src/lib/gateway.ts:3`; `web/trusted-address.cjs` | Medium (not deployed) | 92 |
| 9 | **Password guessing is bounded only per address.** The limit is 30 a minute per IP, counted per Kong node. There is no per-account backoff. A disabled account answers differently once the password is right, which confirms the password. | `gateway/kong.yml` (`identity-login`); `identity/src/application/use-cases/authenticate-account.ts:89` | Low–Medium | 92 |
| 10 | **Kong checks tokens only on `/gateway/verify`.** No business route has the `jwt` plugin, so the gateway's "defence in depth", and the per-consumer limits, do not exist. The services verify every token themselves, so nothing is open. But the root and gateway READMEs say Kong validates tokens. | `gateway/kong.yml:274` is the only `jwt` | Low | 92 |
| 11 | **Dependencies with published advisories:** `multer` and `@nestjs/platform-express` (DoS on multipart, used by imports) in Parties, Financial and Treasury; `@grpc/grpc-js` and `brace-expansion` in most services; `fast-uri` and `ip-address` in the MCP debugger. | `npm audit --omit=dev` in every project | Low–Medium | 90 |
| 12 | Two conflicting rule changes approved at the same moment can both apply. The lock is per change, so a tie between an adopted package and an own rule follows, and calculations answer `AMBIGUOUS_RULE`. It fails safe, but it fails. | `fiscal/src/rule-changes.ts:310` | Low | 91 |
| 13 | Two uploads through the same signed link can leave an attachment unreadable. Both write the same object key, and only the database row is compare-and-set. Decryption then fails, so nothing unscanned is ever served. | `files/src/application/attachments.ts:189` | Low | 92 |

## Checked and found sound

- **Tokens.** Every service accepts EdDSA only, `typ: JWT`, an issuer bound to the `kid`,
  and a maximum age, and checks revocation before any role. Only an Identity owner grants
  roles. Selection, challenge and invitation tokens are opaque and single-use.
- **Tenant isolation in the database.** RLS is enabled and forced on every table of all
  sixteen databases. The only exceptions are Fiscal's migration ledger and the global NCM
  table. The worker roles read only the columns they need.
- **SQL.** Every dynamic fragment is a constant column name, and every value is a
  parameter.
- **The web.** Writes from another site are refused (`Sec-Fetch-Site`, `Origin`), cookies
  are `SameSite=Lax` and `HttpOnly`, and pages carry a nonce CSP and `frame-ancestors
  'none'`. The proxy forwards an allowlist of headers to an allowlist of modules, with no
  `..`.
- **Signed links** (Files, Reporting exports): HMAC over kind, tenant, id and expiry,
  compared in constant time, with a capped lifetime. Downloads are `attachment`,
  `nosniff` and `sandbox`. CSV exports neutralise formulas.
- **The Agent** fills path parameters from UUIDs or closed enums, encoded, and audits
  before it answers.
- **Supplier XML** refuses DTDs and entities, and reads only the canonical `infNFe` the
  signature covers, so there is no signature wrapping. The signature is not anchored to
  ICP-Brasil, which is stated, and an import moves no stock or money.
- **Identity:** a dummy hash is computed for unknown emails, invitations ask an existing
  account for its password, second factors lock after five failures, and service secrets
  are compared in constant time.
- **Limits:** request bodies are bounded in Fiscal's raw server (1 MiB, 256 KiB for
  governance) and at Kong (8 MB, 11 MB for uploads).

## Phase 90 — Who may speak on the bus, and where webhooks may go

1. **A broker identity per module** (findings 1, 11), recorded in a new ADR.
   - **Locally:** one RabbitMQ user per module, created by the platform bootstrap.
   - **Permissions:** each user configures and reads only its own queues
     (`^<module>\.`), and writes only to `horizon.events` and the dead-letter exchange.
   - **Topic permissions:** it may publish only routing keys `^<module>\.`, so Sales
     cannot publish `financial.*`. The administrator user is kept for the management UI
     only.
   - **On AWS:** one secret per service. The users and topic permissions are created by
     the same bootstrap through the management API.
   - **Proof:** an e2e where a module's user publishing another module's routing key is
     refused with `ACCESS_REFUSED`, and the golden path still passes.
2. **Webhook egress** (finding 2):
   - only `https`, to a host that resolves solely to public unicast addresses;
   - every private, loopback, link-local, CGNAT, multicast, documentation and IPv4-mapped
     range is refused, at subscription time and again at connect time, through a pinned
     `lookup` on the HTTP agent, so DNS rebinding finds a closed door;
   - `WEBHOOK_ALLOW_LOOPBACK=true` keeps `http://localhost` for local development only;
   - the attempt log keeps a failure category, never the raw error text.
   - **Proof:** unit tests over each range and over a rebinding resolver; the golden path
     with a loopback receiver under the development flag.
3. **Dependencies** (finding 11): bump `@nestjs/platform-express` (and with it `multer`),
   `@grpc/grpc-js`, `brace-expansion`, `fast-uri` and `ip-address`; `npm audit --omit=dev`
   clean of high findings in every project.

## Phase 91 — Taxes in the books follow the authority, and estimates Fiscal vouches for

To decide with the workspace owner before starting: when the Ledger posts a document's
taxes. The recommendation is **at authorization**, with a reversal at cancellation.

1. **Tax postings follow the document's outcome** (finding 3), amending ADR 0073.
   - The Ledger keeps a lock as a pending fact keyed by the **document**, not the origin.
   - It posts that fact when the document is authorized, and posts its mirror when an
     authorized document is cancelled.
   - A rejected document never posts.
   - A correction's successor is a document of its own: it posts when it is authorized,
     and its rejected predecessor never did.
   - **Proof:** an e2e of lock → reject → correct → authorize posts the taxes once, with
     the corrected amounts; lock → authorize → cancel nets to zero; lock → reject posts
     nothing.
2. **Estimates by reference** (findings 4, 5).
   - Fiscal records every estimate it issues: tenant, input, result, digests, and the
     document it was asked for (kind, id, version).
   - The web sends the owner only the estimate's `resultDigest`. The owner fetches the
     estimate from Fiscal through Kong with the caller's token, checks that its lines and
     version are the document's current ones, and keeps it.
   - Sales removes a quote's estimate when a draft is revised, and takes a new estimate
     only for `draft` and `pending` quotes.
   - Fiscal's purchase projection and `compareTaxes` trust only an estimate found in its
     own record for that tenant and order.
   - **Proof:** a forged estimate is refused by Sales, Procurement and the reconciliation;
     a revised draft has no estimate until it is asked again.
3. **Rule changes are decided one at a time per workspace** (finding 12): the decision
   takes a tenant-wide advisory lock, and two concurrent approvals of conflicting changes
   leave one approved and one refused. **Proof:** a concurrent e2e.

## Phase 92 — The workspace's day, the edge, and the AWS path

1. **The workspace's day** (finding 6).
   - Every module that dates business facts keeps the tenant's timezone from
     `identity.tenant.created`, with a republish command in Identity for existing
     workspaces, and `America/Sao_Paulo` until it arrives.
   - "Today" is computed once at the boundary, in that timezone: overdue titles, lot
     expiry, report and as-of defaults, and Fiscal's competence default.
   - **Proof:** tests at 23:30 in Brasília and at 00:30 UTC on a month's last day.
2. **A local stack that listens only locally** (finding 7): every published port binds
   to `127.0.0.1` unless `HORIZON_BIND_ADDRESS` says otherwise. Kong's Admin API is not
   published. Redis takes a password, and Grafana's admin password comes from `infra/.env`.
3. **The AWS path** (finding 8):
   - `HORIZON_API_URL`, `HORIZON_COOKIE_SECURE=true` and `HORIZON_WEB_TRUSTED_HOPS=1` for
     the web;
   - `KONG_TRUSTED_IPS` set to the VPC range and `KONG_REAL_IP_HEADER=X-Forwarded-For` for
     the gateway;
   - the probe and the retention job as scheduled tasks;
   - a `terraform test` assertion for each.
4. **Password guessing** (finding 9): a Redis counter of failures per account and per
   address, with progressive delay instead of a lockout. A disabled account answers like
   a wrong password until the password and the second factor are both proved.
5. **Kong checks tokens where every request carries one** (finding 10):
   - the `jwt` plugin on every authenticated route, leaving out the public ones (`/auth`,
     JWKS, signed links, invitations, the Agent's MCP endpoint, which takes an API key);
   - the AWS gateway image renders its consumers from the published keys at start;
   - the READMEs say what is true either way.
6. **One object per upload** (finding 13): each upload writes its own object key, the
   compare-and-set winner keeps it, and the loser's object is removed.

Each phase ends with the usual gates: `ci-local --full`, `make demo` twice, `test-alerts`
and `test-phase10`, and `deck` whenever `gateway/kong.yml` changes.
