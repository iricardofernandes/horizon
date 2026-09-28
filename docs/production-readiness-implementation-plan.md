# Production readiness implementation plan — Phase M

Status: **delivered, Phase M closed on 2026-09-28** — Phases 61 to 63 delivered on 2026-09-27 ([61](readiness-phase61-evidence.md), [62](readiness-phase62-evidence.md), [63](readiness-phase63-evidence.md)), Phases 64 to 70 on 2026-09-28 ([64](readiness-phase64-evidence.md), [65](readiness-phase65-evidence.md), [66](readiness-phase66-evidence.md), [67](readiness-phase67-evidence.md), [68](readiness-phase68-evidence.md), [69](readiness-phase69-evidence.md), [70](readiness-phase70-evidence.md)). This is the execution plan for Phase M of the
[ERP expansion plan](erp-expansion-plan.md#phase-m--reporting-data-operations-and-product-hardening),
split into phases 61–70 of [plan.md](plan.md). Each numbered phase gets its own detailed
plan before implementation, one local commit and an evidence record, as in Phases J to L.

## Outcome and boundaries

Phases A to L built what a business does. Phase M makes it something a business can
**run on**:
- **Reporting:** numbers that cross modules and still agree with the modules they came
  from;
- **Data in and out:** getting data in and out in bulk without losing a row;
- **Everyday use:** finding anything quickly and being told what needs attention;
- **Access:** protecting access beyond a password;
- **Controls:** keeping one person from both doing and approving the same thing;
- **Recovery:** proving, with stored evidence, that the data comes back after a
  failure.

The three exit criteria of the expansion plan are the acceptance tests of this plan:
1. Cross-domain reports reconcile against their operational sources at a declared
   cutoff.
2. Imports are resumable and idempotent, and never partially hide failed rows.
3. Security and recovery drills produce stored evidence, not only documentation.

Out of scope:
- **A BI tool or ad hoc query builder.** Reports are designed, named and tested, and a
  saved filter narrows one.
- **Charts beyond the dashboard's few fixed shapes.** Tables come first (Phase 25's rule
  still holds).
- **Email as a notification channel.** Notifications are in-app; email carries
  invitations only. Webhooks remain the machine channel.
- **SSO (SAML/OIDC federation) and SCIM provisioning.**
- **Multi-region deployment and active-active failover.** The recovery objectives are for
  one region restored from backups.
- **Real antivirus signatures in CI.** The scanner is a port. Locally it is ClamAV, and in
  CI a deterministic adapter that flags the EICAR test file.
- **Real bank, fiscal or email providers.** They stay behind the ports and mocks of their
  phases.

## What already exists

| Need | Where it is today |
|---|---|
| The rule for cross-module reports | ADR 0047: a `reporting/` context consumes events, never writes back, is rebuildable and states its cutoff |
| Reports inside one module | Aging (`financial/`), statements and cash (`treasury/`), trial balance and DRE (`ledger/`), stock valuation (`inventory/`), forecast and metrics (`crm/`) |
| Cutoff semantics | CRM Phase 59: facts refused more than 2 minutes from the database clock; a cutoff is settled after 10 minutes |
| Replaying events | Parties `republish:parties`; bounded fiscal replay (ADR 0055); webhooks replay |
| A file upload with a preview | Treasury OFX/CSV statement import (Phase 20) |
| Long-running jobs | Sales billing runs (Phase 52), CRM `rebuild:metrics`, fiscal batches |
| Object storage | MinIO in the local stack, used by Fiscal for XML and DANFE artifacts |
| Audit | A hash-chained, append-only audit log per module (ADR 0025), with a chain check in Identity |
| Sessions | Rotating refresh-token families with reuse detection (ADR 0020), a `jti` denylist (ADR 0021) |
| Second-person approval | Payables above a per-currency policy (`financial/`), purchase requisitions and orders (`procurement/`), stock adjustments and counts (`inventory/`) |
| Restore checks | Per-phase scripts: `phase48-restore-drill.sh`, `phase53-restore-check.sh`, `phase60-restore-check.sh` |
| Observability | OpenTelemetry → Jaeger, Prometheus, Loki and Grafana; alert rules with tests for Sales and Fiscal |

Gaps:
- Nothing reads across modules. A question such as "what was ordered, invoiced,
  received and reconciled this month" needs five screens and a spreadsheet.
- **Moving data in bulk:**
  - there is no export except the browser's copy;
  - the only import is a bank statement.
- **Finding and noticing:**
  - there is no search across modules and no notification;
  - a job is only visible on the screen that started it.
- **Access:**
  - a user is created with a password chosen by an administrator;
  - there is no MFA, no passkey and no list of one's own sessions.
- **Controls:**
  - segregation of duties is enforced per module, differently, and not at all for some
    postings;
  - approval cannot be delegated during an absence;
  - the audit log can only be read in the database.
- **Recovery:** the restore scripts cover one module each, and no objective (RPO/RTO) is
  stated or measured.
- **Service levels:** there is no service-level indicator and no synthetic probe of the
  critical path.

## Decisions to take first (Phase 61)

1. **`reporting/` keeps its own journal of the events it consumes** (ADR 0058, extending
   ADR 0047).
   - Every event `reporting/` consumes is kept in an append-only `event_journal`:
     tenant-scoped, deduplicated by event id, with the payload as received.
   - Projections are functions of that journal, so a rebuild replays the journal, not the
     broker.
   - History from before `reporting/` existed comes from each producer's **bounded
     republish** command:
     - it is idempotent by event id;
     - it is keyed by tenant and time range;
     - it follows the `republish:parties` pattern.

     A producer without one gains it in the phase that first needs its history.
   - **Cutoffs:**
     - every report is read as of a cutoff on the instant `reporting/` recorded the fact;
     - a cutoff is settled once every source's watermark has passed it;
     - the report answers the cutoff, `settled`, and each source's watermark.
2. **Reports reconcile or say why not** (ADR 0058).
   - Every cross-domain report has a reconciliation check against the owning module's own
     report at the same settled cutoff: aging, statement, trial balance or stock
     valuation.
   - The check is an executable test in CI and a scheduled job in the stack. Its results
     are stored and shown next to the report.
   - A difference is a defect, never a footnote.
3. **Bulk data is moved by jobs owned by the module that owns the data** (ADR 0059).
   - **Imports:**
     - An import is a job inside the owning module (Parties, Catalog, Inventory…),
       validated by the module's own domain. Nothing writes to a module from outside it.
     - Every module implements the same job contract: `uploaded → validated → previewed →
       running → completed | completed-with-failures | cancelled`.
     - Rows are processed in batches, each row with a key derived from the job and row
       number, so a restart never writes a row twice.
     - A failed row stays in the job with its reasons. The failures download as a file in
       the input's own format.
     - "Completed" is never shown while any row is unaccounted for.
   - **Exports:**
     - Exports of reports are jobs in `reporting/`.
     - Exports of an operational list are streamed by the web server from the owning
       module's paginated API, as the signed-in user, up to a declared row limit. Above
       it, the screen offers the report export instead.
   - **Files and formats:**
     - Files live in object storage under a tenant prefix, and download through
       short-lived signed links.
     - The formats are CSV (UTF-8 with BOM, `;` for pt-BR and `,` for en) and XLSX.
4. **Where user-owned presentation state lives.**
   - Saved filters and views, notifications with their read state, and scheduled exports
     belong to `reporting/`. They are read models and preferences, not business facts.
   - This does not break ADR 0047: `reporting/` still never writes to an operational
     database.
5. **Attachments are a module of their own: `files/`, port 3014** (ADR 0060). This
   revises the module list of the expansion plan, which ended at `reporting`.
   - An attachment references `(module, recordType, recordId)`.
   - It may be attached or read by a user holding the owning module's `write` or `read`
     role, checked from the token like any route (ADR 0023).
   - **Lifecycle:** `uploading → scanning → available | quarantined → deleted`. A
     quarantined file is never served.
   - **Scanning:** it is a port: ClamAV locally, and a deterministic EICAR adapter in CI.
   - **Encryption and erasure:** each file is encrypted under a key per record owner
     (party or user). Erasing the owner destroys the key, the same crypto-shredding as
     ADR 0026.
   - **Retention:** it is per record type. Expiry is a job, never a silent delete.
   - It holds no roles of its own, so it needs no module name in contracts until it is an
     API-key scope.
6. **Access hardening stays in Identity** (ADR 0061).
   - **Invitations:**
     - An invitation replaces the administrator-chosen password: a single-use link, valid
       for 72 hours, sent by an outbound mail port. The local stack uses Mailpit.
     - The invited person sets their own password.
   - **MFA:**
     - TOTP with ten one-time recovery codes;
     - passkeys (WebAuthn) as a second factor, or as the only factor when the workspace
       allows it.
   - **Workspace policy:** MFA can be required for everyone or for chosen modules' admin
     roles.
   - **Sessions:** each refresh-token family becomes a visible session (device, IP prefix,
     last use). A user revokes their own sessions; an administrator revokes anyone's.
   - A token issued before MFA was completed carries `amr` without MFA and cannot reach a
     route that requires it.
7. **Segregation of duties is a declared matrix, enforced by each module** (ADR 0062).
   - One table in `@horizon/contracts` lists the conflicting pairs, for example:
     - create a payable / approve it;
     - request a purchase / approve the order;
     - adjust stock / approve the override;
     - post a manual journal entry / approve it.
   - Each owning module enforces its pairs in its domain, with the same refusal code.
   - Approval can be **delegated** for a date range to someone holding the approver role.
     The delegate's approval records both names, and a delegate can never approve their
     own work.
   - The **audit screen** reads each module's audit log through a new read endpoint, with
     filters and the chain-verification status. There is no central copy of the audit
     log.
8. **Recovery is measured, not described** (ADR 0063).
   - **Objectives:** RPO 15 minutes (WAL archiving and base backups) and RTO 1 hour for
     the full stack, each stated in the runbook.
   - **Restore drill:** it restores every module database and the object storage into a
     fresh stack, then runs:
     - the reconciliation checks;
     - the audit chain check;
     - a synthetic golden path.

     It stores a signed evidence record (timings, digests, results) as a build artifact
     and in `docs/drills/`.
   - **Retention:** it is declared per table class, as operational, audit, messaging,
     export or attachment. Retention jobs log what they removed. The audit log and
     posted records are never removed by retention.

## Phases

### 61 — Phase M decisions and the reporting journal

[Detailed Phase 61 plan](readiness-phase61-implementation-plan.md) ·
[evidence](readiness-phase61-evidence.md).

**Work**
1. ADRs 0058–0063 record the decisions above, indexed in `docs/adr/README.md`. The
   expansion plan's module list and port table gain `files` (3014).
2. Contracts 0.46.0 declare the module `reporting` (roles `admin`, `analyst`, `viewer`)
   and the journal seal. `files` is not declared: it holds no roles of its own, so it
   needs no module name until it is an API-key scope (ADR 0060). Every service is pinned
   to 0.46.0.
3. `reporting/` joins the platform with the full wiring checklist, on port 3013 behind
   `/reporting`, with database `horizon_reporting`.
4. **The event journal:**
   - an inbox consumer for every published business event type;
   - the append-only `event_journal`, with forced RLS and a trigger that refuses updates;
   - per-source watermarks.
5. **Filling the journal:**
   - producers gain a bounded `republish` command where the first reports need history:
     Sales, Financial, Treasury, Inventory, Procurement and Ledger.
6. `GET /sources` answers each source's watermark and lag, and whether a cutoff is
   settled.

**Exit evidence**
- Duplicate and out-of-order delivery leave the journal unchanged.
- Republishing a range twice changes nothing.
- A tenant's journal is invisible to another.
- A service lagging on the old contracts pin is caught by the pin check.

### 62 — Cross-domain reports reconciled at a cutoff

[Detailed Phase 62 plan](readiness-phase62-implementation-plan.md) ·
[evidence](readiness-phase62-evidence.md).

**Work**
1. **Four reports, each a query over the journal at the cutoff:**
   - cash position;
   - order to cash;
   - procure to pay;
   - pipeline to revenue.

   Stock against the ledger moves to Phase 69's consistency checks.
2. `GET /reports/{name}?cutoff=&…` for each, and a dashboard of their headline figures.
   Every figure carries the cutoff and whether it is settled.
3. **Reconciliation checks:**
   - each figure is checked against its owning module's report, or marked derived;
   - runs are started by a person, with that person's access to the owners, and stored as
     `reconciliation_runs` with each difference;
   - scheduled runs move to Phase 69.
4. **Saved report filters** per user, and shared ones for the workspace.
5. **Scheduled seals:** each producer the reports read seals its tenants on a schedule,
   and CRM gains `republish:journal`.

**Exit evidence**
- The local stack's history reconciles to zero difference in every check.
- A late event after a settled cutoff never changes it.
- A journal row cannot be changed, and a gap shows as a seal mismatch.

### 63 — Exports and scheduled exports

[Detailed Phase 63 plan](readiness-phase63-implementation-plan.md) ·
[evidence](readiness-phase63-evidence.md).

**Work**
1. **Report exports:**
   - `POST /exports` creates a job (report, filter, cutoff, format, locale);
   - a worker writes CSV or XLSX to object storage (MinIO, now in the default platform);
   - the file downloads through a link signed for 15 minutes;
   - it expires by retention.
2. **Scheduled exports:**
   - a report, a filter or saved filter, and a cadence (daily, weekly or monthly) in the
     schedule's own timezone;
   - each run's cutoff is its due instant, and missed runs are caught up once each.
3. **List exports from the web server:** any paged list is exported as CSV as the
   signed-in user, up to 50,000 rows, with the instant and the filter in its header.
4. **The export button** on the CRM accounts and pipeline, Catalog items and Procurement
   orders. The reports screen, with its own button, is Phase 70.

**Exit evidence**
- An exported report's totals equal the report at the same cutoff.
- A user without read access to a module cannot export its list.
- Formula injection is neutralized: cells starting with `=`, `+`, `-` or `@` are quoted.

### 64 — Bulk imports with preview and failures you can download

[Detailed Phase 64 plan](readiness-phase64-implementation-plan.md) ·
[evidence](readiness-phase64-evidence.md).

**Work**
1. **The import job contract:**
   - states, row keys, batch size, cancellation and resume;
   - the failures file;
   - a shared JSON shape for progress.

   It is specified once in contracts and implemented per module.
2. **First importers:**
   - parties with their roles and documents (Parties);
   - items, units and price lists (Catalog);
   - opening stock balances by location, lot and serial (Inventory);
   - open receivables and payables at go-live (Financial).
3. **The flow:**
   - upload a file (CSV or XLSX);
   - map its columns;
   - validate every row with the module's domain;
   - preview the counts and the first errors;
   - confirm;
   - follow the progress.
4. **The web import wizard,** generic over any module that implements the contract.

**Exit evidence**
- Killing the service mid-import and restarting it finishes with every row written once.
- A file with invalid rows imports the valid ones, and reports every invalid one with its
  line and reason.
- The totals on the screen always add up to the file's row count.
- Importing the same file twice with the same job key writes nothing new.

### 65 — Attachments

**Work**
1. `files/` joins the platform on port 3014 behind `/files`, with database
   `horizon_files` and a bucket per environment.
2. **Upload and download:**
   - upload through a signed URL, with the size and type allow-listed;
   - scan through the port: ClamAV in the local stack, EICAR in CI;
   - then `available` or `quarantined`;
   - download through a signed link, only when the file is available.
3. **Encryption:** envelope encryption per owner key.
   - Erasure listens to `parties.party.erased` and `identity.data-subject.erased`.
   - `files.attachment.*` events carry no file name.
4. **Retention** per record type, with an expiry job and its log.
5. **The attachments panel** on parties, purchase orders, titles, service orders and
   opportunities.

**Exit evidence**
- The EICAR file is quarantined and never served.
- An attachment of an erased party cannot be decrypted.
- A user without the owning module's role cannot list or read its attachments.
- A cross-tenant read returns nothing.

### 66 — Search, command palette, saved views, notifications and the job centre

**Work**
1. **Global search is federated.**
   - The web server asks each module the user can read through its existing list search,
     with a time budget per module.
   - It shows what answered and says which module did not.
   - No central index holds personal data.
2. **The command palette** (Ctrl/⌘ K) offers navigation, actions the user's roles allow,
   and search results.
3. **Saved views** per list screen: filter, sort and columns, per user and shared.
4. **Notifications** in `reporting/`, from events:
   - a CRM reminder that fell due;
   - an approval waiting for the user or their delegator;
   - a finished import, export or billing run;
   - a quarantined file;
   - a failed reconciliation check.

   They carry a bell, read and unread state, and a link to the record.
5. **The background-job centre** lists the user's imports, exports, billing runs, fiscal
   batches and rebuilds across modules, with their progress and results.

**Exit evidence**
- Search shows nothing the user's roles could not read, and one module being down does not
  break it.
- A notification is created once per event, even on replay.
- The palette and the bell work from the keyboard alone.

### 67 — Invitations, MFA, passkeys and sessions

**Work**
1. **Invitations:**
   - an administrator invites by email with roles;
   - the link is single use and valid for 72 hours;
   - the invited person sets their own password;
   - an invitation is revoked or resent.

   The mail port is Mailpit locally.
2. **MFA:**
   - TOTP enrollment with a QR code and ten recovery codes, each stored hashed and used
     once;
   - passkey enrollment and sign-in (WebAuthn);
   - step-up before sensitive actions: API keys, roles and MFA reset.
3. **Workspace MFA policy:** off, required for admins, or required for everyone, with a
   grace period for enrollment.
4. **Sessions and devices:** list, revoke one, and revoke all others. An administrator
   ends a user's sessions. Revocation also denylists live access tokens.
5. Every change is audited without secrets.

**Exit evidence**
- A security drill script:
  - brute force on TOTP locks out;
  - a replayed recovery code is refused;
  - a revoked session's access token is refused within its lifetime;
  - an expired or used invitation is refused.

  It stores its results.

### 68 — Segregation of duties, delegation and the audit screen

**Work**
1. **The duties matrix:** it lives in contracts, and each module enforces its pairs:
   - Financial: create or approve a payable;
   - Procurement: request, approve or order;
   - Inventory: adjust or override;
   - Ledger: manual entry or approve;
   - Treasury: create a transfer or approve it.

   The refusal code is shared.
2. **Approval delegation:** the approver names a delegate for a date range.
   - The delegate's approvals record both names.
   - A delegate can never approve their own work.
   - A delegation is audited, and ends or is revoked.
3. **An audit read endpoint** in every module:
   - paginated;
   - filtered by actor, action, record and period;
   - chain-verification status per page.
4. **The audit screen:** a federated search across modules, with export (Phase 63).

**Exit evidence**
- Every pair in the matrix is refused in an e2e test of its module, and allowed through a
  valid delegation to someone else.
- A tampered audit row shows as a broken chain on the screen.

### 69 — Backups, restore drills, retention and consistency checks

Carried over from Phase 62:
- a service identity for scheduled work, so reconciliation runs on a schedule, not only
  when a person asks;
- stock against the ledger as a consistency check.

**Work**
1. **Backups:**
   - WAL archiving and scheduled base backups for PostgreSQL;
   - versioned object storage.

   Their configuration and the runbook state RPO 15 minutes and RTO 1 hour.
2. **The full restore drill**, `scripts/restore-drill.sh`:
   - it restores every module database and the bucket into a fresh stack;
   - it restores to a point in time;
   - it checks, then stores the drill's evidence.
3. **Retention policies** per table class, as retention jobs with logs:
   - inbox and outbox;
   - expired exports;
   - denylist and sessions;
   - attachments past retention.
4. **Financial consistency checks**, scheduled with stored results:
   - receivables and payables against their ledger control accounts;
   - treasury balances against cash accounts;
   - stock valuation against inventory accounts;
   - the audit chain of every module.

**Exit evidence**
- The drill runs from nothing to a verified stack within the RTO.
- The point-in-time target lands inside the RPO.
- A deliberately broken balance is caught by the consistency check.

### 70 — Service levels, synthetic monitoring, release evidence and closing Phase M

**Work**
1. **SLIs and SLOs:**
   - login, order to shipment, invoice issuance (simulation), payment settlement, report
     freshness and import throughput;
   - Prometheus recording and alert rules, each with its rule test;
   - a Grafana dashboard.
2. **A synthetic probe** of the critical path, on a schedule against the stack: log in,
   read a report, create and cancel a draft order. It reports the probe's SLI and alerts
   on failure.
3. **The screens:** reports and dashboard, exports, imports, the job centre,
   notifications, MFA and sessions, audit, and settings (retention, MFA policy,
   delegation), in pt-BR and en.
4. **Release evidence:**
   - a Phase M golden path: import → operate → reconcile → export → drill;
   - the browser workflow;
   - the security and restore drills;
   - the threat model and API reference.
5. **Close Phase M** in `docs/plan.md`, `docs/erp-expansion-plan.md` and this plan.

**Exit evidence**
- The three expansion-plan exit criteria are proven, each by a stored artifact:
  1. reconciliation runs at a settled cutoff with zero difference;
  2. an interrupted import with failed rows, finished and fully accounted for;
  3. the security and restore drill records.

## Order and dependencies

- **61 goes first.** It sets the module names, and every service's pin, before any grant.
- **Reporting track:** 62 needs 61's journal; 63 needs 62's reports.
- **64 is independent of reporting** and can follow 61.
- **65 needs 61's decisions,** and nothing else from 61.
- **66 comes after 63–65**, because it shows their jobs and notifies about them.
- **67 and 68** are independent of reporting and can follow 61.
- **69 comes after 65 and 68**, because it restores attachments and checks the audit chains.
- **70 closes the phase** and depends on all of them.

## Risks

| Risk | Signal | Response |
|---|---|---|
| The journal misses events published before a republish command exists | A report reconciles in CI but not on a long-lived stack | Reconciliation is the gate: a producer gains its republish command in the phase whose report needs it |
| A report's cutoff hides lag | Figures change for a cutoff shown as settled | A cutoff is settled only on every source's watermark, never on the wall clock alone |
| Imports become a back door around the domain | An importer writes tables directly | Importers call the module's own use cases, and the e2e test compares against the same command through the API |
| MFA locks out the only administrator | The workspace has no way back in | Recovery codes, the policy's grace period, and a runbook for an operator-assisted reset that is audited |
| The phase is too wide to finish | Several phases half done | Each phase is shippable on its own; 61–64 already meet exit criteria 1 and 2 |
