# Service levels

Delivered in [Phase 70](readiness-phase70-implementation-plan.md).
- **Rules:** `infra/observability/rules/slo.rules.yml`, tested with `make test-alerts`.
- **Dashboard:** *Horizon — service levels* in Grafana.

The objectives are local defaults: the deployment owner sets production ones.

| Service level | SLI (recording rule) | Objective | Alert |
|---|---|---|---|
| Login availability | `1 - sli:login_errors:ratio_rate1h`: answers of `POST /auth/login` that are not `5xx`, from Kong's `identity-login` route. A wrong password is a correct answer | 99.5% over 30 days | [LoginAvailabilityBurn](#loginavailabilityburn) |
| Login latency | `sli:login_under_1s:ratio_rate5m`: answered within one second | 95% | [LoginLatencySlow](#loginlatencyslow) |
| Order to shipment | `sli:order_to_shipment_within_48h:ratio_rate1d`: shipments that left within 48 hours of their order's confirmation (`sales_order_to_shipment_seconds`) | 95% | [OrderToShipmentSlow](#ordertoshipmentslow) |
| Invoice issuance (simulation) | `sli:invoice_authorized:ratio_rate1h`: authorized among the documents the authority decided (`fiscal_authority_outcomes`) | 99% | [InvoiceIssuanceFailing](#invoiceissuancefailing) |
| Payment settlement | `sli:settlement_delivered:ratio_rate1h`: settlement events consumed by Treasury and Ledger, against their dead letters | 99.9% | [SettlementsDeadLettered](#settlementsdeadlettered) |
| Report freshness | `sli:report_freshness_seconds:max`: per source, seconds since the oldest tenant's watermark (`reporting_source_freshness_seconds`) | under 15 minutes | [ReportsStale](#reportsstale) |
| Import throughput | `sli:import_rows:rate5m`: rows written or refused per second, while `sli:import_jobs_active:sum` jobs run | never zero for 15 minutes while a job runs | [ImportsStalled](#importsstalled) |
| The critical path | `sli:probe_success:ratio_rate1h`: runs of the synthetic probe (`horizon-probe`) that signed in, read the dashboard, drafted and cancelled a purchase order, and signed out | 99% | [SyntheticProbeFailing](#syntheticprobefailing) |

Availability alerts use two windows, one hour and five minutes, at 14.4 times the error
budget: at that rate a month's budget is gone in about two days. The other alerts hold for
a time, so a single bad sample does not page.

## Runbooks

### LoginAvailabilityBurn
Sign-in answers `5xx`.
1. Check Identity's health (`/identity/health/ready`), its PostgreSQL pool and Redis. The
   challenge, the selection and the lockout all live in Redis.
2. Kong's error log tells a gateway failure from an Identity one.
3. Once it is fixed, the burn rate falls within five minutes. The hour window clears
   later.

### LoginLatencySlow
Sign-in is slow, not failing.
- Password hashing (Argon2id) is the usual cause: look at Identity's CPU.
- Next is Redis latency.
- A burst of wrong passwords against one account is throttled by the rate limit, not
  slowed.

### OrderToShipmentSlow
Orders wait more than 48 hours to leave.
- This is an operational signal as much as a technical one.
- Look at the Sales *deliveries* screen for orders confirmed and not picked.
- Look at Inventory for stock reserved but not available.
- A Fiscal gate may hold a packed shipment waiting for its authorization.

### InvoiceIssuanceFailing
The authority (the simulator locally) rejects documents.
- `fiscal_authority_outcomes_total{outcome="rejected"}` carries the rejection code.
- The Fiscal support screen lists the documents.
- Follow the [Fiscal operations runbook](fiscal-operations-runbook.md).

### SettlementsDeadLettered
Treasury or Ledger could not handle a message: a settlement may be recorded in Financial
without reaching the treasury account or the ledger.
1. Inspect the dead-letter queue in RabbitMQ.
2. Fix the cause: usually a missing ledger mapping, which the ledger keeps `pending`
   instead.
3. Replay the message.

The next consistency run (see the [recovery runbook](recovery-runbook.md)) shows whether
the books agree again.

### ReportsStale
A source's seals stopped for some tenant.
1. Look at `GET /reporting/sources`.
2. Look at the producer's `JournalSealWorker` log.
3. Check that its relay role can connect.

A producer restored from a backup behind Reporting shows as a seal mismatch, not as
staleness.

### ImportsStalled
A job has been `running` for 15 minutes without accounting for a row.
- Look at the owning module's import worker log.
- A lease that lapsed is taken again automatically. A job stuck on one row names it in the
  failures file.
- Cancelling leaves every row accounted for.

### SyntheticProbeFailing
The probe could not sign in, read the dashboard, draft or cancel a purchase order, or sign out.
Its log
(`docker logs horizon-probe`) names the step and the status. Each step's own alert usually
fires too.

## The probe

`tooling/probe` (the `horizon-probe` container) walks the critical path through Kong every
`PROBE_INTERVAL_SECONDS`, 60 by default:
1. signs in and enters the workspace;
2. reads the Reporting dashboard;
3. drafts a purchase order shaped on the newest existing one (its supplier, warehouse and
   item, one unit at one cent);
4. cancels that draft;
5. signs out, so its sessions do not pile up. It signs out even after a failed step.

It uses its own account, `probe@horizon.local`, created by `make probe-user`: Procurement
`buyer` and Reporting `viewer` in the demo workspace. It never uses a person's account.
Its drafts carry the note `PROBE-<date>`, and none outlives its run.

Prometheus scrapes it on `horizon-probe:9464`:
- `horizon_probe_runs_total{outcome}`;
- `horizon_probe_step_seconds{step}`, the latest duration of each step;
- `horizon_probe_last_success_timestamp_seconds`.

## Phase N — the agent, the index, search and suggestions

Delivered in [Phase 78](ai-phase78-implementation-plan.md).
- **Rules:** `infra/observability/rules/phase-n.rules.yml`, tested with `make test-alerts`.
- **Dashboard:** *Horizon — Phase N* in Grafana.

| Service level | SLI (recording rule) | Objective | Alert |
|---|---|---|---|
| Agent calls answered | `sli:agent_calls_failed:ratio_rate10m`: tool calls whose outcome is `failed`, where Horizon could not answer (`agent_tool_calls_total`). A refusal (scope, arguments, not found) is a correct answer | under 1% | [AgentCallsFailing](#agentcallsfailing) |
| Agent call latency | `sli:agent_calls_under_2s:ratio_rate10m`: from `tools/call` to its audited answer, within two seconds (`agent_tool_call_seconds`) | 95% | [AgentCallsSlow](#agentcallsslow) |
| Index freshness | `sli:document_index_lag_seconds:max`: how long the oldest due document has waited, across tenants (`knowledge_index_lag_seconds`) | under 10 minutes | [DocumentIndexBehind](#documentindexbehind) |
| Search latency | `sli:document_search_under_1s:ratio_rate10m`: searches answered within a second (`knowledge_search_seconds`) | 95% | [DocumentSearchSlow](#documentsearchslow) |
| API key exchanges refused (Phase 81) | `sli:api_key_exchanges_refused:increase5m`: exchanges refused or rate-limited in five minutes (`identity_api_key_exchanges_total{outcome}`). No key label; the log names the key | none unexplained | [ApiKeyExchangesRefused](#apikeyexchangesrefused) |
| Suggestion acceptance | `sli:suggestions_accepted:ratio_1d`: accepted among decided suggestions over a day, per kind (`knowledge_suggestion_decisions_total`). A quality signal, never a training set | 30% or more, with at least 20 decisions | [SuggestionsRarelyAccepted](#suggestionsrarelyaccepted) |

Every Phase N duration histogram has bounds in seconds, from 5 ms to 60 s (300 s for the
assistant and for embedding). Before Phase 78 they used OpenTelemetry's millisecond
defaults, so every measurement fell into the first bucket.

### AgentCallsFailing
Horizon could not answer the tenants' agents: the gateway or a module was unreachable, or
the call could not be audited. An unaudited call returns no data (ADR 0065), so an audit
failure shows up here too.
1. `docker logs horizon-agent`, and the module named by the failing tools
   (`sum by (tool) (rate(agent_tool_calls_total{outcome="failed"}[10m]))`).
2. Kong's `agent-api` route, and the module's own health.
3. The agent's database: an audit append that fails fails the call.

### AgentCallsSlow
Each call exchanges the key (`agent_exchange_seconds`), then reads through Kong. Compare the
exchange's p95 with the call's. If the exchange is slow, Identity's Argon2id verification
or Redis is the cause; otherwise the module being read is.

### DocumentIndexBehind
The worker is not keeping up, or a document is stuck due.
1. `docker logs horizon-knowledge`: failed passes are logged by error class.
2. `knowledge_documents_settled_total{state="pending"}` growing means files are failing and
   being retried: check `files/` through Kong, and the service token.
3. With `make up-ai`, a stopped TEI stops embedding: `curl 127.0.0.1:8088/health`.

### DocumentSearchSlow
A search embeds the question and asks two lists of one tenant's partition.
- With e5, TEI's latency comes first.
- Otherwise look at the partition's size and plan: `EXPLAIN` a nearest query in the tenant,
  which must name one partition and its HNSW index.

### ApiKeyExchangesRefused
More than 20 key exchanges were refused or rate-limited in five minutes. The usual causes:
- a key that was revoked, or has outgrown its issuer, is still in use;
- a leaked key is being tried;
- an integration is looping.

1. `docker logs horizon-identity | grep 'API key exchange'`. Each line names the key by its
   prefix (`hz_…<prefix>`) and the outcome. The secret is never logged.
2. Match the prefix under *Developers → API keys* in the issuing workspace.
   - **`refused`:** the key is revoked or unknown, or its issuer lost a role it needs.
   - **`rate-limited`:** the key is being used faster than 120 exchanges a minute.
3. If the use is not the owner's, revoke the key. The next exchange is then refused, and a
   token already issued expires within a minute.

### Rotating a master key (Phase 81)
`knowledge/` wraps document keys and `agent/` wraps person keys with a master key
(ADR 0068). To rotate one:
1. **`knowledge/` only:** set `KNOWLEDGE_LEXEME_KEY` to the current master key's value, so
   the keyed full-text index stays as it is. Leaving it unset means the lexemes follow the
   new master key, and every document is re-indexed in the background.
2. Move the current key to `…_PREVIOUS_MASTER_KEYS` (comma-separated), and put the new one in
   `KNOWLEDGE_MASTER_KEY` / `ASSISTANT_MASTER_KEY`. Restart the service.
3. The rewrap worker moves every key, a batch at a time (`…_REWRAP_INTERVAL_MS`).
   `knowledge_keys_on_old_master_keys` and `assistant_keys_on_old_master_keys` fall to 0,
   and the log says "every … key is wrapped under the current master key".
4. Remove the old key from `…_PREVIOUS_MASTER_KEYS`, and restart.

Nothing is re-encrypted but the wrapped keys: chunks and turns stay sealed under their own
data keys. A key that no listed master key opens is logged by error class and left as it is.

### SuggestionsRarelyAccepted
People reject most suggestions of one kind. That is a quality signal, not an outage.
- For `ncm`, the official table alone is a weak prior (heading hit@3 of 5 in 12, Phase 77):
  a workspace with little classified history sees mostly table candidates.
- For `payable-category`, a change in how the workspace categorizes makes old payables vote
  for categories no longer used.

## Phase O — the tax engine

Delivered in [Phase 89](tax-phase89-implementation-plan.md).
- **Rules:** `infra/observability/rules/phase-o.rules.yml`, tested with `make test-alerts`.
- **Dashboard:** *Horizon — Phase O* in Grafana.

| Service level | SLI (recording rule) | Objective | Alert |
|---|---|---|---|
| Preview latency | `sli:tax_previews_under_500ms:ratio_rate10m`: previews answered within half a second (`fiscal_tax_calculation_seconds{operation="preview"}`) | 95% | [TaxPreviewSlow](#taxpreviewslow) |
| Unsupported answers | `sli:tax_unsupported:ratio_30m`, and `sli:tax_unsupported_by_dimension:increase30m` by refusal code and kind of missing dimension (`fiscal_tax_answers_total`). A label names a kind (`line`, `classification-ncm`, `tax`…), never a value | watched; no objective | [TaxUnsupportedSurge](#taxunsupportedsurge) |
| Oracle agreement | `sli:tax_oracle_disagreements:max`: lines the engine and the official calculator answered differently, or the calculator refused, in the last recorded run, by kind (`fiscal_tax_oracle_disagreements`, `fiscal_tax_oracle_refusals`) | zero | [TaxOracleDisagrees](#taxoracledisagrees), [TaxOracleStale](#taxoraclestale) |
| Locks replay | `sli:tax_lock_replays_failed:increase1h`: locked calculations the worker's sampler could not reproduce byte for byte (`fiscal_tax_lock_replays_total`) | zero | [TaxLockReplayFailed](#taxlockreplayfailed) |

The sampler replays up to 10 random locks of the last 30 days, per served workspace, every
10 minutes. An oracle run is recorded with
`node scripts/tax-oracle.mjs --record-by <who>` and `DATABASE_URL`, or afterwards with
`npm run tax:oracle-record -- --by <who> <report.json>…` in `fiscal/`.

### TaxPreviewSlow
A preview reads the workspace's rules and adopted packages, then calculates.
1. Compare the preview's p95 with the lock's (`operation="lock"`): if both are slow,
   Fiscal's database is the cause (`pg_stat_activity`, the connection pool).
2. A workspace that adopted many packages reads many rules: `GET /fiscal/rules` and
   `GET /fiscal/catalog/packages` show how many.

### TaxUnsupportedSurge
More than half of the answers are `unsupported`. It is information: the engine refuses
what it has no evidence for (ADR 0072).
1. `sli:tax_unsupported_by_dimension:increase30m` names the code and the kind of what is
   missing.
2. `classification-ncm` or `line`: items without an approved classification, or a scenario
   no rule covers. `tax` with `UNSUPPORTED_SCENARIO`: a calculation outside the support
   matrix.
3. Supporting a scenario is a fixture the workspace owner approves and a package adopted
   through a request (ADR 0074), never a configuration change.

### TaxOracleDisagrees
The engine and the official calculator answered a line differently: either a published
package is wrong, or the calculator changed.
1. Read the report named by the last run (`docs/drills/<date>-phase84-oracle-<kind>.json`):
   each difference names its class and line.
2. If the calculator's digest changed, `make tax-oracle` refuses it: review the new version
   before trusting it.
3. Hold the support matrix: no new adoption of the affected package until the difference
   is explained. A locked document never changes.

### TaxOracleStale
No run was recorded in eight days. Run `make tax-oracle` with `--record-by`, or record the
CI job's reports with `tax:oracle-record`.

### TaxLockReplayFailed
A locked calculation did not reproduce its stored result: this should never happen.
1. `docker logs horizon-fiscal`: the sampler counts, it does not name the document.
2. `npm run phase82:catalog -- verify-lock --tenant <id> --document <id>` on recent locks
   names the one that fails, and its digests.
3. Suspect the master key (`FISCAL_ARTIFACT_KEY_HEX`) after a restore or a rotation, then
   a change to the interpreter: a lock replays from its own stored rules, never from the
   catalogue.
