# Phase 69 — Backups, restore drills, retention and consistency checks

Status: **delivered on 2026-09-28** ([evidence](readiness-phase69-evidence.md)). This is the execution record for
[Phase 69 of the production readiness plan](production-readiness-implementation-plan.md#69--backups-restore-drills-retention-and-consistency-checks).
Decision: [ADR 0063](adr/0063-recovery-is-measured-by-drills.md). It uses ADR 0058 (the
reporting journal), ADR 0062 (the audit read endpoints) and ADR 0023 (static roles).

## Result

After this phase:
- **Backups.** PostgreSQL archives its WAL at least every 5 minutes, and a backup
  container takes compressed base backups on a schedule. The object store keeps versions.
  The runbook states RPO 15 minutes and RTO 1 hour, and how each is met.
- **The restore drill.** `scripts/restore-drill.sh` builds a fresh stack from the backups
  alone:
  - PostgreSQL, from the last base backup and the WAL, to a point in time;
  - the object store, to the same point in time;
  - every service, and a gateway of its own.

  It then checks that stack and stores the evidence with timings. It fails if it misses
  the RPO or the RTO.
- **Retention jobs.** Old delivery bookkeeping (inboxes, command receipts, idempotency
  keys) is removed by a scheduled job, which logs the counts per class and tenant. Exports,
  attachments, the denylist and sessions already expire. The job reports them too.
- **Consistency checks.** Reporting compares, on a schedule and on request, and stores each
  run:
  - receivables and payables with their ledger control accounts;
  - treasury balances with the cash accounts;
  - the stock valuation with the inventory accounts;
  - the audit chain of every module.
- **Two things carried over from Phase 62:**
  - a service identity, so scheduled work reads other modules without a person's token;
  - reconciliation of every report on a schedule.

## Starting point

- **PostgreSQL:** one cluster, one database per module, and no WAL archiving. The per-phase
  restore checks (48, 53, 60) dump and restore one database each.
- **MinIO:** buckets for exports, attachments and fiscal artifacts, without versioning.
- **Retention:**
  - inboxes and command receipts are never removed;
  - outboxes are kept on purpose (ADR 0058);
  - exports expire after 72 hours (Phase 63);
  - attachments expire by record type (Phase 65);
  - the denylist and sessions live in Redis with a TTL (Phase 67).
- **Reading another module:** Reporting reads other modules only with the caller's token
  (Phase 62). Nothing can run on a schedule.
- **Audit logs:** each module's log can be read and judged per page (Phase 68). Only its
  admin may read it.
- **The ledger:** it maps receivables, payables and cash, and has no inventory role. Stock
  is not posted to it.

## Decisions frozen by this plan

1. **Objectives, and how they are met.**
   - **RPO 15 minutes:**
     - `archive_mode=on`;
     - `archive_timeout=300`: a segment is archived at least every 5 minutes, even when
       quiet;
     - `archive_command` copies each segment to the `postgres-wal` volume, never
       overwriting.
   - **RTO 1 hour:**
     - a base backup every 6 hours (`BASEBACKUP_INTERVAL_SECONDS`), so at most 6 hours of
       WAL are replayed;
     - the drill times every step, and fails above 3,600 seconds.
   - **Base backups:**
     - a `postgres-backup` container runs `pg_basebackup` through the cluster's local
       socket (a shared volume), as tar and gzip;
     - it keeps the last 7 (`BASEBACKUP_KEEP`), with a manifest (label, start WAL,
       digest, size);
     - it removes the WAL older than the oldest backup kept (`pg_archivecleanup`).
   - **Object storage:** versioning is on for every bucket, set by `minio-init`.
2. **A service identity** (`POST /auth/service-token`).
   - **The caller:** a service client, named in Identity's `SERVICE_CLIENTS` with the
     SHA-256 of its secret. The only client is `reporting`, whose secret is
     `SERVICE_TOKEN_SECRET`.
   - **The token:**
     - issued for one tenant that exists, with the usual access-token lifetime;
     - subject `service:reporting`, with no session;
     - roles fixed in Identity's code, never configured (ADR 0023).
   - **Every token is audited** in the tenant's chain (`service-token.issued`).
   - **Its roles are read-only:**
     - `viewer` in the modules whose reports are reconciled or checked (Sales, Financial,
       Treasury, Ledger, Procurement, Inventory, CRM);
     - `auditor` in every module with an audit log.
3. **A new `auditor` role** (contracts 0.51.0) in the eleven modules that keep an audit
   log and have roles.
   - It reads the audit log and nothing else.
   - Files keeps no roles (ADR 0060): its log is read by Identity owners, admins and
     auditors.
   - A person can hold the role too, for example an external auditor.
   - The audit screen asks every module where the person is admin or auditor.
4. **Consistency checks** live in Reporting (`consistency_runs`, append-only).
   - They compare owners' figures now, per currency. Each check is `matched`,
     `differences` (with both figures), `not-applicable` or `unread`:

     | Check | Owner | Ledger |
     |---|---|---|
     | `receivables-control` | `/financial/receivables/summary`, outstanding | balances of the accounts mapped to `receivables` (`/ledger/mappings`, `/ledger/accounts?asOf=`) |
     | `payables-control` | `/financial/payables/summary` | the accounts mapped to `payables` |
     | `cash-accounts` | `/treasury/accounts`, book balance | the accounts mapped to `cash` |
     | `inventory-accounts` | `/inventory/stock-valuation`, totals | the accounts mapped to the new `inventory` role; `not-applicable` when none is |
     | `audit-chains` | `GET /<module>/audit`, every page | none: every module's verdict, with the broken sequences |

   - The run also records how many ledger facts are waiting for a mapping
     (`/ledger/postings/pending`), since they explain a control account's difference.
   - **Routes:** `POST /reporting/consistency-checks` runs one now, with the caller's
     token (`admin` or `analyst`). `GET /reporting/consistency-checks` lists runs.
   - **The ledger gains an `inventory` posting role.** Stock movements are not posted, so
     the account is adjusted by manual entries, and the check says by how much it is off.
5. **Scheduled work in Reporting** (`ScheduledControlsWorker`,
   `CONTROLS_INTERVAL_SECONDS`, default daily).
   - For every tenant in the journal (read as the relay role), it asks for a service token.
   - It runs the consistency checks.
   - It reconciles each report at its latest settled cutoff. A report that is not settled
     is skipped, and that is logged.
   - Runs record `trigger: scheduled` and the actor `service:reporting`.
6. **Retention jobs** (`infra/retention`, a small container with its policy in
   `policy.json`).
   - **Rules per class:**

     | Class | Tables | Age |
     |---|---|---|
     | Delivery bookkeeping | every module's `inbox` | 90 days |
     | Command receipts | `command_receipts`; Fiscal's idempotency tables | 30 days |
     | Posted, audit, event history | journals, titles, audit logs, outboxes | never |

   - **How it deletes:** as each module's relay role, in batches. Each module's migration
     grants that role `DELETE`, and `SELECT` on the tenant and age columns only, under a
     `relay_retention` policy.
   - **What it reports** alongside:
     - exports and attachments past their expiry that are still present (their own
       workers remove them);
     - Redis denylist and session keys without a TTL.
   - **Every run logs one JSON line per class, table and tenant** with the count removed,
     and a summary line. Loki collects them.
7. **The drill** (`scripts/restore-drill.sh`, with `scripts/restore-drill-verify.mjs`).
   1. **Take a base backup** if the last one is older than its interval.
   2. **Mark the point in time.** Write a marker row and object, take the database time as
      the target, then write a second marker row and object after it. Switch the WAL.
   3. **"Fail":** the clock starts.
   4. **Restore PostgreSQL** into a new container, from the base backup and the archive,
      with `recovery_target_time`, and promote it.
   5. **Restore the buckets** into a new MinIO, as they were at the target
      (`mc cp --rewind`).
   6. **Start a fresh stack on them:**
      - a new Redis and RabbitMQ;
      - every service, from its built image and the environment the live one runs with,
        rewritten to the drill's stores;
      - a Kong of its own on port 18000.
   7. **Verify:**
      - the first marker (row and object) is present and the second is absent;
      - the data lost is within the RPO;
      - every module's audit chain, for every tenant, through the drill gateway;
      - the consistency checks;
      - a deliberately broken balance (a manual entry posted to the receivables control
        account, in the drill's copy only) is caught;
      - a synthetic sign-in of the demo user, and a report read.
   8. **Store the evidence** in `docs/drills/`: timings, digests, results, and pass or fail
      against both objectives. Then remove the drill stack.

## Work

### A — Contracts 0.51.0
1. The `auditor` role in eleven modules, and the consistency run schema.
2. Publish, and repin every service.

### B — The auditor role in every module
Every audit route admits `auditor` alongside `admin`. So do Identity's `read Audit` and
Files' readers, and the web's audit sources.

### C — Identity
`POST /auth/service-token`, the `SERVICE_CLIENTS` setting, its audit, and tests.

### D — Ledger
The `inventory` posting role, and its migration.

### E — Reporting
1. **The consistency checks:**
   - domain: compare figures, and each check's outcome;
   - application: run the checks;
   - infrastructure: `consistency_runs`, the migration, the routes.
2. **The scheduled worker:**
   - the tenant scan, as the relay role;
   - the service token client;
   - scheduled reconciliations.
3. **Tests:**
   - unit tests of the comparisons;
   - e2e tests of a run and its storage, with owners faked;
   - a broken balance caught.

### F — Retention
1. **A migration in every module with an inbox or command receipts,** granting the relay
   role its retention access.
2. **`infra/retention`:** the runner, `policy.json`, its unit tests, and its Compose
   service.

### G — Infrastructure
1. WAL archiving.
2. The `postgres-backup` service.
3. Bucket versioning.
4. The runbook, `docs/runbooks/recovery.md`.
5. Make targets: `backup-now` and `restore-drill`.

### H — Evidence
1. The drill run, stored in `docs/drills/`.
2. A retention run's log.
3. A scheduled consistency run on the live stack.

## Exit evidence

- The drill runs from nothing to a verified stack within the RTO.
- The point-in-time target lands inside the RPO.
- A deliberately broken balance is caught by the consistency check.

## Left for Phase 70

- **Screens** for consistency runs and retention.
- **SLIs and alert rules** on the drill and the checks (for example, a scheduled check with
  differences).

## Revisions made while implementing

- **The service token has no `amr` and the usual lifetime.** Its `service:` subject and
  the absence of a session mark it; the signer is shared with people's tokens.
- **Auditors pass a module's general role check.** Sales, CRM and Reporting required a read
  role before any route, and Fiscal read before every route, so an auditor got `403`. Their
  audit routes now judge the role themselves; everything else still refuses an auditor.
- **Attachments are versioned** (ADR 0063 revised): noncurrent versions expire after 30
  days, so erasure completes within that window.
- **The drill's gateway has to prove where it points.** A first run rewrote no gateway
  host, so its HTTP checks reached the live services and posted its broken balance to the
  live ledger (reversed at once, see the evidence). The drill now refuses a gateway that
  still reaches a live service, and checks that its posting exists only in its own copy.
- **A fresh RabbitMQ volume needs its Erlang cookie seeded,** and every wait in the drill has
  a deadline, so a step that cannot finish stops the drill with its reason.
