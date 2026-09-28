# Phase 69 — evidence: backups, restore drill, retention and consistency checks

Status: **delivered on 2026-09-28** (local runs between 18:40 and 19:40 UTC).
Plan: [readiness-phase69-implementation-plan.md](readiness-phase69-implementation-plan.md).
Decision: [ADR 0063](adr/0063-recovery-is-measured-by-drills.md), revised.
Runbook: [recovery-runbook.md](recovery-runbook.md).
Drill record: [drills/2026-09-28-phase69-restore-drill.json](drills/2026-09-28-phase69-restore-drill.json).

## What was delivered

- **Backups.**
  - PostgreSQL archives every WAL segment, closing one at least every 5 minutes.
  - `postgres-backup` takes a compressed base backup every 6 hours through the local socket,
    keeps 7 with a manifest each, and prunes the WAL behind the oldest.
  - Every MinIO bucket is versioned. Noncurrent versions expire: attachments after 30 days,
    exports after 7.
- **Contracts 0.51.0,** with every service repinned:
  - the `auditor` role in the eleven modules with audit logs and roles;
  - the consistency run schema.
- **The auditor reads audit logs and nothing else.** On the live stack, one auditor token
  read `GET /audit` with `200` in all twelve modules (Files through `identity:auditor`). It
  got `403` on Sales orders, payables, the ledger, Catalog items, Fiscal documents and CRM
  accounts.
- **Identity service tokens:** `POST /auth/service-token`.
  - The `reporting` client is named with the SHA-256 of its secret.
  - Its roles are read-only and fixed in code.
  - Every issue is in the tenant's chain.
- **The ledger** gains an `inventory` posting role.
- **Reporting:**
  - `POST` and `GET /consistency-checks`, with the runs kept in `consistency_runs`
    (append-only, with an audit link);
  - `ScheduledControlsWorker`: for every tenant in the journal, a service token, the
    consistency checks, then each report reconciled at its latest settled cutoff.
- **Retention:**
  - `tooling/retention` (the `horizon-retention` container) runs with `policy.json`;
  - a migration in each of 13 modules grants the relay role `DELETE` on its inbox or
    command receipts, and `SELECT` on their tenant and age only.
- **The drill:** `scripts/restore-drill.sh` and `scripts/restore-drill-verify.mjs`.
- **Make targets:** `backup-now`, `retention-now`, `restore-drill`.
- **Web:** the audit screen also reads the modules where the person is an auditor.

## Exit criteria

`make restore-drill` stored `"passed": true`, run `20260928T193455Z`:

| Criterion | Evidence |
|---|---|
| **From nothing to a verified stack within the RTO** | From the failure to verified: **18 s**, against 3,600. Restoring PostgreSQL took 4 s, the buckets 3 s, starting 14 services and a gateway 8 s, and verifying 3 s. The base backup was `20260928T184352Z` (31.8 MB, SHA-256 `2494…2986`), replayed with its WAL |
| **The point-in-time target lands inside the RPO** | Target `19:35:05.406Z`. The row and the object written before it are in the restored stores, and the ones written after it are not. The last replayed commit is the "before" marker, 9.8 s before the target, the quiet time the drill leaves. At most 300 s of committed work can be lost (`archive_timeout`); at the failure the last archived segment was 0 s old; `failed_count` was 0 |
| **A deliberately broken balance is caught** | In the drill's copy, the golden-path tenant's receivables control **matched** (BRL). The drill posted 123.45 to the receivables control account through the drill gateway, and the next run showed `differences`: owner `0`, ledger `12345`, the posted amount exactly. The posting exists in the drill ledger (1) and not in the live one (0) |

**The drill also proved:**
- every audit chain of the 18 tenants with an audit log (52 chains, 4,429 rows) judges the
  same restored as live, through the drill's own gateway. The three Treasury chains
  tampered on purpose in Phase 68 read broken in both, at the same rows;
- the demo user signs in to the restored stack (`/auth/login`, workspace, `/identity/me`,
  Catalog items, all `200`);
- the restored buckets hold 644 fiscal artifacts, 47 exports and 2 attachments.

## The scheduled controls on the live stack

At 19:37, five minutes after Reporting started, the worker ran over the 7 tenants in its
journal.
- **Checked:** four tenants, each with a stored `scheduled` run by `service:reporting`.
- **Refused:** Identity refused a token (`401`) for the other three. They exist only in
  the journal, written by smoke tests with minted tokens, so the refusal is right.
- **Reconciliations:**
  - the demo tenant and the golden-path tenant reconciled all four reports as `matched`;
  - the two others had no settled cutoff and were skipped as `not-settled`.
- **A real difference, to investigate** (Phase 70): in the golden-path tenant,
  `cash-accounts` found treasury book balances of 3,223.50 BRL against 3,486.00 in the
  ledger's cash accounts, with no ledger fact waiting for a mapping. It is kept in the run.

## Retention on the live stack

- **`make retention-now`:** removed nothing, and all 20 rules ran. Reported as overdue: 0
  exports, 0 attachments, and 0 Redis keys without a TTL under the four Identity prefixes.
- **With five Financial inbox rows set 100 days old and three command receipts 40 days
  old**, the next pass removed exactly those 8 rows. It logged one line per class and
  tenant (5 and 3, for tenant `01a0b6b8…`) and a `retention.run` summary. The table counts
  went from 3,852 and 133 to 3,847 and 130.

## Tests

- **Contracts:** 149 unit tests, among them the auditor role and the consistency run.
- **Identity:** 242 unit tests, 3 new for service tokens.
- **Reporting:**
  - 79 unit tests: the comparisons, the chains check, the run and its incomplete and
    inconsistent cases, and the settled cutoff;
  - 20 e2e tests, 2 new: runs kept and never rewritten, and the relay tenant scan that
    reads nothing else.
- **Fiscal:** 172 unit tests, the auditor on `/audit` only among them. The inbound e2e
  tests pass.
- **Retention:**
  - 4 unit tests: the policy refuses audit logs, outboxes and bad identifiers, and a failed
    rule does not stop the others;
  - 2 e2e tests: batched removal per tenant, as the relay role, which cannot read a row's
    content.
- **Every module with a retention migration** passed its e2e tests after it:

  | Identity | Catalog | Sales | Financial | Treasury | Ledger | Procurement |
  |---|---|---|---|---|---|---|
  | 50 | 40 | 32 | 48 | 24 | 38 | 27 |

  | Inventory | CRM | Reporting | Files | Webhooks | Fiscal inbound |
  |---|---|---|---|---|---|
  | 65 | 30 | 20 | 8 | 3 | 5 |
- **`make check`:** passed.

## Findings along the way

- **The first passing drill run was not valid, and it wrote to the live ledger.** The
  gateway rewrite built its host list with `${SERVICES[*]// /|}`, which leaves the spaces,
  so no host was rewritten. The drill's gateway reached the live services, and its HTTP
  checks ran against the live stack. Its broken-balance posting landed twice in the live
  ledger (runs `…192952Z` and `…193311Z`).
  - Both postings were reversed at once through `POST /ledger/transactions/{id}/reverse`,
    with the reason recorded.
  - The drill now refuses a gateway that still reaches a live service, and checks that its
    posting exists only in its own copy.
  - The run above is the first one with both guards.
- **`recovery_target_time` needs an explicit offset;** an ISO `Z` suffix is refused, and the
  restored server stops. The drill's waits now have deadlines.
- **A fresh RabbitMQ volume leaves the Erlang cookie unreadable.** The drill seeds it.
- **An auditor was refused before reaching the audit route** in Sales, CRM, Reporting and
  Fiscal, whose general role checks come first. Their audit routes now judge the role.
- **`pg_basebackup` refuses a non-empty target,** so the error log was moved out of it.
