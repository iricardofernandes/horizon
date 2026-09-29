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

### SuggestionsRarelyAccepted
People reject most suggestions of one kind. That is a quality signal, not an outage.
- For `ncm`, the official table alone is a weak prior (heading hit@3 of 5 in 12, Phase 77):
  a workspace with little classified history sees mostly table candidates.
- For `payable-category`, a change in how the workspace categorizes makes old payables vote
  for categories no longer used.
