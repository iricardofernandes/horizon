# Recovery runbook — backups, restore, retention and consistency

Decision: [ADR 0063](adr/0063-recovery-is-measured-by-drills.md). Delivered in
[Phase 69](readiness-phase69-implementation-plan.md).

## The objectives

| Objective | Target | How it is met | How it is proven |
|---|---|---|---|
| **RPO**: data that may be lost | 15 minutes | Every WAL segment is archived (`archive_mode=on`), and one is closed at least every 5 minutes (`archive_timeout=300`) even when the cluster is quiet. At most 5 minutes of committed work is outside the archive | The drill restores to a point in time and checks the last replayed commit, and the age of the last archived segment at the moment of failure |
| **RTO**: time to a verified stack | 1 hour | A base backup every 6 hours bounds the WAL to replay. The restore is scripted end to end, and the stack starts from built images | The drill times each step from the failure to a verified stack, and fails above 3,600 seconds |

Both hold for one region, restored from its backups. Active-active failover is out of scope
(Phase M).

## What is backed up

- **PostgreSQL**, every module database in one cluster.
  - **WAL:** archived to the `postgres-wal` volume by `archive_command`. A segment already
    there is never overwritten.
  - **Base backups:** `postgres-backup` runs `infra/postgres/backup/basebackup.sh`.
    - It uses `pg_basebackup` through the cluster's local socket (the `postgres-socket`
      volume), as a compressed tar.
    - It runs every `BASEBACKUP_INTERVAL_SECONDS` (6 hours) and keeps `BASEBACKUP_KEEP` (7),
      about 42 hours.
    - Each backup carries a `manifest.json`: label, first WAL segment, size and SHA-256.
    - The WAL older than the oldest backup kept is removed. The point-in-time window is
      therefore the last 42 hours.
  - **Take one now:** `make backup-now`.
- **Object storage.** Every bucket is versioned: fiscal artifacts, exports and attachments.
  - An overwritten or removed object keeps its earlier versions, so a restore can take
    each bucket as it was at a point in time.
  - **Noncurrent versions expire:** attachments after 30 days, exports after 7. Fiscal
    artifacts are kept.
- **Not backed up:**
  - **Redis** holds the denylist, sessions and challenges, all with a TTL. A restore starts
    with an empty Redis, so everyone signs in again.
  - **RabbitMQ** holds messages in flight. A restore starts empty, and the outboxes
    republish whatever was not yet delivered.

## Erasure and backups

- An erased subject's key is destroyed in the live database (ADR 0026). A base backup
  still holds that key until it ages out, at most 42 hours.
- An attachment's removed version stays in object storage for up to 30 days, as ciphertext
  under an owner key that erasure has already destroyed in every backup younger than 42
  hours.
- **Erasure is therefore complete after 30 days,** and the privacy notice states this
  window.
- **A restore inside that window must replay the erasures made since the target.**
  - List them in the live databases:
    - `select tenant_id, id from data_subject_keys where erased_at > '<target>'` in
      Identity;
    - the key tables with an `erased_at` column in Parties, CRM and Files (`owner_keys`).
  - Erase each subject again in the restored stack.

## Restoring for real

1. **Choose the target:** an instant before the damage, inside the last 42 hours.
2. **Stop writes** to the damaged stack: stop the app containers, not PostgreSQL.
3. **Rehearse:** run `make restore-drill` with `--keep`. It builds the restored stack beside
   the live one, on port 18000, and verifies it. To use a target other than "now", change
   `TARGET` in `scripts/restore-drill.sh`.
4. **Promote:**
   - point the gateway at the restored services, or swap the volumes (`horizon-drill-pgdata`
     for `postgres-data`, `horizon-drill-objects` for MinIO's);
   - restart the app containers;
   - replay the erasures made since the target (see above).
5. **Record** the incident, the target, and the drill evidence the rehearsal stored.

A restored stack must not deliver webhooks to customers until it is promoted. The drill
stack runs on the local network only.

## Retention

`horizon-retention` (`tooling/retention`) runs daily, as each module's relay role. That role
may see only a row's tenant and age.

| Class | Tables | Removed after |
|---|---|---|
| Delivery bookkeeping | every module's `inbox` | 90 days, longer than any redelivery or dead-letter replay |
| Command receipts | `command_receipts` | 30 days, longer than any client retry |
| Posted and audit records, event history | journals, titles, audit logs, outboxes, the reporting journal, Fiscal's idempotency | never |
| Generated files | exports | 72 hours, by Reporting's own worker (Phase 63) |
| Attachments | `files/` | per record type, by Files' own worker (Phase 65) |
| Denylist, sessions, challenges | Redis | their TTL |

- **Each run logs** a `retention.removed` line per class, table and tenant, and a
  `retention.run` summary.
- **The summary also counts:**
  - exports and attachments still present an hour past their expiry;
  - Redis keys under Identity's prefixes that have no TTL.

  All of them should be zero.
- **One pass now:** `make retention-now`.

## Consistency checks

Reporting runs them daily for every tenant, with its service identity. It keeps each run in
`consistency_runs`.

| Check | Owner | Ledger |
|---|---|---|
| `receivables-control` | outstanding receivables per currency | accounts mapped to `receivables` |
| `payables-control` | outstanding payables per currency | accounts mapped to `payables` |
| `cash-accounts` | treasury book balances | accounts mapped to `cash` |
| `inventory-accounts` | stock valuation | accounts mapped to `inventory` (not posted automatically; kept by manual entries) |
| `audit-chains` | every page of every module's audit log | none |

- **Where to read them:** `GET /reporting/consistency-checks`. To run one now,
  `POST /reporting/consistency-checks`, with the caller's own access.
- **A difference names both figures.** The run also says how many ledger facts wait for a
  mapping, which is the usual reason a control account is short.

## The drill

`make restore-drill` (`scripts/restore-drill.sh`) stores its evidence in `docs/drills/`.

**What it does:**
1. Takes a base backup if none exists.
2. Marks a target between two markers.
3. Restores PostgreSQL and the buckets to that target.
4. Starts every service and a gateway on the restored stores.

**What it checks:**
- the markers;
- the RPO;
- every tenant's audit chains, restored against live;
- the consistency checks, including a balance broken on purpose in the drill copy;
- a synthetic sign-in;
- the RTO.

It exits non-zero when any check fails.
