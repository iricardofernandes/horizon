# Phase M threat model

Scope: what Phase M (production readiness, Phases 61–70) added across the modules:
- the sealed event journal and cross-module reports;
- exports and imports;
- attachments;
- search and notifications;
- second factors, invitations and sessions;
- segregation of duties, delegation and the audit read;
- backups, restore, retention and consistency checks;
- the service levels and the synthetic probe.

The decisions are [ADR 0058](adr/0058-reporting-keeps-a-sealed-event-journal.md) to
[ADR 0063](adr/0063-recovery-is-measured-by-drills.md). The plan is
[production readiness](production-readiness-implementation-plan.md).

Each row names the control, and the test or evidence that proves it. A threat without a proof
is listed as open.

## Assets

| Asset | Where | Why it matters |
|---|---|---|
| The event journal and seals | Reporting: `event_journal`, `source_seals`, `source_watermarks` | Every cross-module report is computed from them |
| Report files | Reporting: `export_jobs`; the `horizon-exports` bucket | Leave the system; carry figures of several modules |
| Import files and their rows | `import_jobs`, `import_rows` in Parties, Catalog, Inventory and Financial | Bulk personal and financial data, written as the uploader |
| Attachments | Files: `attachments`, sealed objects in `horizon-files` | Documents about parties and titles; erasable with the party |
| Second factors and sessions | Identity: TOTP secrets (sealed), recovery code digests, passkeys, session families, the Redis denylist | Whoever holds them is the person |
| Approvals and delegations | Each deciding module: `approval_delegations`, thresholds, the pending queues | Who may move money or stock alone |
| Audit logs | `audit_log` in every module, hash-chained | The record of who did what |
| Backups | `postgres-base`, `postgres-wal`, bucket copies | A full copy of every tenant |
| Service credentials | `SERVICE_CLIENTS` digests; the Reporting service secret; the probe's account | Act without a person |

## Trust boundaries

1. **Browser → web → Kong → module.**
   - The session cookie becomes a short EdDSA token.
   - Each module maps its own roles to actions. The web only hides what a role cannot use.
2. **Module → broker → Reporting, Files and the notification intake.**
   - Producers publish; consumers deduplicate by event id.
   - Since Phase 90 each module is a broker user of its own: it publishes only its own
     events and seals, and a consumer refuses a message whose routing key is not the event
     it names ([ADR 0075](adr/0075-one-broker-identity-per-module.md)).
   - Seals prove completeness; an arrival proves only itself.
3. **Reporting → owners, with the caller's token.**
   - Reconciliation and consistency checks ask each owner's own report as the person who
     asked, or as `service:reporting` with a token from `POST /auth/service-token`.
4. **Signed links → Kong → Reporting or Files.** Public routes that trust a signature, not a
   token.
5. **Tooling → databases.** Retention, the freshness gauge and the tenant scans use the relay
   role, which reads only named columns.
6. **Backups → object storage and restore.** The drill restores into its own stack
   (`horizon-drill-*`), and refuses a gateway that points at a live service.

## Threats and controls

### Reports and the journal

| Threat | Control | Proof |
|---|---|---|
| A tenant reads another tenant's journal or reports | RLS forced on every Reporting table; tenant from the token only | [Phase 61 evidence](readiness-phase61-evidence.md): another tenant's role reads no journal, seal or watermark row; smoke with another tenant's token sees every source empty |
| A lost or duplicated event silently changes a report | The journal dedupes by event id; a seal matches the producer's count through an instant; a report is `settled` only through proven watermarks | Phase 61 e2e and smoke (republished twice, journal unchanged); Phase 62 smoke (six checks `matched`) |
| A report at a settled cutoff changes later | Figures read the journal through the cutoff only; late events land after it | [Phase 62 evidence](readiness-phase62-evidence.md): a later win shows at now and leaves the cutoff identical |
| A report disagrees with the owning module | Reconciliation asks each owner's report at the same cutoff, as the caller | Phase 62 smoke; the Phase M golden path: `cash-position` `matched` at the settled cutoff |
| A foreign event in the journal holds a source back | A seal whose counts differ is `mismatched`, and the watermark stays; `ReportsStale` names the source | **Found in Phase 70:** a test event in the demo tenant's CRM journal holds CRM's watermark, and the alert fired. See the [Phase 70 evidence](readiness-phase70-evidence.md) |

### Files that leave the system, and files that come in

| Threat | Control | Proof |
|---|---|---|
| An export leaks figures to someone without the role | An export needs Reporting `export`; a list export is read page by page with the person's own token | [Phase 63 evidence](readiness-phase63-evidence.md): a user without a CRM role gets `403` and no file |
| A download link is forged, replayed later, or reused by another tenant | HMAC over tenant, job and expiry; 15 minutes; the file carries its SHA-256 | Phase 63 e2e; Phase 70: the browser download's SHA-256 equals the listed digest |
| A spreadsheet formula runs on the reader's machine | Cells starting with `=`, `+`, `-`, `@`, tab or carriage return are escaped | Phase 63 unit tests and smoke |
| An import writes a row twice or loses one on a crash | Leased jobs; each row written once under its key; progress must add up | [Phase 64 evidence](readiness-phase64-evidence.md) (killed mid-import); Phase M golden path (restarted mid-import: 1,000 written, 25 refused, none lost) |
| Import rows keep personal data in clear | `import_rows` cells are sealed | Phase 64 smoke: no clear name in `import_rows` |
| A malicious attachment is served | Every upload is scanned; a finding is quarantined and its bytes removed | [Phase 65 evidence](readiness-phase65-evidence.md): EICAR with both scanners |
| An erased party's attachments can be read | A key per party, destroyed on erasure; a destroyed key cannot be restored | Phase 65 smoke and e2e |

### Search, notifications and access

| Threat | Control | Proof |
|---|---|---|
| Search shows what a role cannot read | Only readable modules are asked, with the person's token | [Phase 66 evidence](readiness-phase66-evidence.md) |
| A replayed event notifies twice | The intake dedupes by event id; notifications are append-only | Phase 66 smoke and e2e |
| Brute force on a second factor | Lockout after repeated wrong codes; the right code is refused while locked | [Phase 67 drill](drills/2026-09-28-phase67-security-drill.json) |
| A stolen session keeps working | Revoking a session denies its access token in every module within its lifetime | Phase 67 drill: `401` in Identity and Catalog after revocation |
| An invitation is reused | Single use, with an expiry | Phase 67 drill: second accept `410` |
| Sign-in is flooded | Kong rate-limits `POST /auth/login` at 30 a minute; `LoginAvailabilityBurn` and `LoginLatencySlow` watch it | `kong.yml` route `identity-login`; `make test-alerts` |

### Controls and recovery

| Threat | Control | Proof |
|---|---|---|
| One person does and approves the same thing | The declared pairs of ADR 0062, refused with the pair named | [Phase 68 evidence](readiness-phase68-evidence.md): every pair in its module's e2e; Phase 70: the Treasury screen shows the refusal to the requester |
| A delegation outlives its reason | At most 90 days, revocable, and the decision records whom it was made for | Phase 68 e2e (`decided_for`) |
| An audit row is edited | Hash chains checked on every read and in the daily consistency run | Phase 68 (tampered rows shown as broken); Phase 69 drill (same verdict restored as live) |
| Books drift apart between modules | Daily consistency checks compare owners' controls with the Ledger | [Phase 69 evidence](readiness-phase69-evidence.md); the drill catches a broken balance |
| A backup cannot be restored in time | Base backups every 6 h, WAL every 5 min; the restore drill is timed | [Phase 69 drill](drills/2026-09-28-phase69-restore-drill.json): verified in 18 s against an RTO of 3,600 |
| A drill writes into the live stack | The drill refuses a gateway that points at a live service, and proves its write exists only in the copy | Phase 69 drill check "the drill writes only to its own copy" |
| Retention removes records it must keep | Only delivery bookkeeping is removed, by a declared age, as the relay role | `tooling/retention` tests; Phase 69 live run |
| The probe's account is used to do harm | Its own account with only Procurement `buyer` and Reporting `viewer`; every draft is cancelled in the same run; sessions are ended | `tooling/probe` tests; the probe's orders carry `PROBE-` notes and end cancelled |
| A failure goes unnoticed | SLOs with multi-window alerts, each with a runbook; a synthetic probe of the critical path | [Service levels](service-levels.md); `make test-alerts` |

## Open

- **Seals skip a tenant with no events from a source.** A producer's periodic seal walks
  its outbox, so a tenant with no events from it is never sealed again after a republish.
  Its watermark then goes stale. The mitigation is `republish:journal --tenant`. The fix is
  for producers to seal every tenant they know. Found in Phase 70.
- **Alert delivery.** Alerts are evaluated and tested, but routing them to a person
  (Alertmanager, a pager) belongs to the deployment.
- **The probe's password** is a local default in Compose. A deployment sets
  `HORIZON_PROBE_PASSWORD`, and rotates it like any other secret.
