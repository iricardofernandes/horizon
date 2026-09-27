# CRM threat model

Scope: accounts, contacts, pipelines, opportunities, activities, tasks, notes, reminders,
the conversion to a Sales quote, and the forecast and metrics in `crm/`, plus the
opportunity projection and quote attribution in `sales/`, as delivered through Phase 60
([ADR 0057](adr/0057-crm-accounts-are-parties-with-typed-documents.md),
[CRM plan](crm-implementation-plan.md)). Each row names the control and the test or
evidence that proves it. A threat without a test is listed as open.

## Assets

| Asset | Where | Why it matters |
|---|---|---|
| Contact personal data | `contacts` (name, job title, email, phone as ciphertext), `contact_data_keys` | The CRM's own personal data about people at an account |
| Record text | `activities`, `tasks`, `note_revisions` (ciphertext), `account_data_keys` | Free text that may name a person |
| Opportunity history | `opportunity_events` (append-only) and its fold in `opportunities` | The source of truth for the pipeline and every metric |
| Attribution | `quotes.opportunity_id`, `attributed_owner_id`, `attributed_source_id` in Sales; `opportunity_quotes` and the conversion in CRM | Who sold what, from which source |
| Metric projections | `metric_states`, `metric_stage_visits`, `metric_closures` | Forecast and conversion numbers a business reads and reports |
| CRM events | CRM outbox: `crm.opportunity.*`, `crm.task.due` | Consumed by Sales and webhooks; they must not leak personal data |

## Trust boundaries

1. **Browser → web → Kong → CRM.**
   - The session cookie becomes a short EdDSA token.
   - CRM checks it and maps the `crm` role to `read`, `write`, `assign`, `configure` or
     `erase`.
2. **CRM ↔ broker ↔ Parties, Identity and Sales.** CRM only listens:
   - to party events, for accounts;
   - to user events, for owners;
   - to `sales.quote.*`, for conversion.

   It never calls or writes another module. Sales learns about opportunities from CRM's
   events only.
3. **The web's conversion.** It calls Parties and Sales as the signed-in user, with that
   user's roles. CRM grants nothing on anyone's behalf.
4. **CRM → database.**
   - One role per module, and RLS forced on every table.
   - The relay role reads the outbox, and only the scan columns of `tasks` (tenant,
     status, reminder instants).

## Threats and controls

| Threat | Control | Proof |
|---|---|---|
| A tenant reads or changes another tenant's CRM data | RLS forced on every table; tenant from the verified token only | CRM e2e: cross-tenant reads on every table of Phases 55–59; restore check: another tenant sees nothing |
| Contact personal data read from a database copy | Fields sealed with AES-GCM under a key per contact, bound to tenant, contact and field | CRM e2e: rows hold only ciphertext; restore check restores ciphertext and keys as they were |
| Personal data kept after an erasure request | Erasing a contact destroys its key; erasing a party destroys its contacts' keys and the account's key, and cancels its open tasks; a destroyed key cannot come back (trigger) | CRM e2e (Phases 55 and 57); restore check: an erased key refuses to be restored |
| Personal data leaks through events or logs | Opportunity events carry ids, stages, amounts and dates, never the title or contacts; `crm.task.due` carries no title; the audit log records field names, never values | Contract tests refuse a `title`; CRM e2e checks the outbox and the audit log for text; smokes read the bus |
| The opportunity history is rewritten | Append-only by trigger; the record is its fold, checked against a rebuild | CRM e2e; restore check |
| A report changes after the fact | The history refuses a fact recorded more than two minutes from the database clock; a cutoff older than ten minutes is settled; metrics read recorded instants, not business dates | Phase 59 e2e (back-dated fact refused; later and replayed facts leave the cutoff alone); restore check |
| Metric projections drift from the history | Rows are a function of each opportunity's history, replaced with it; the rebuild reports drift and compares every number | Phase 59 e2e (dropped and hand-edited rows); the golden path's rebuild |
| A reminder is sent twice | Claimed per tenant with `FOR UPDATE SKIP LOCKED`; `reminded_at` and the outbox row in one transaction | Phase 57 e2e (concurrent and restarted schedulers); smoke with a container restart; golden path: one `crm.task.due` |
| The reminder scheduler reads record text across tenants | It asks as the relay role, which reads only the scan columns of `tasks`; the reminders are claimed as the app role under RLS | Phase 57 e2e; restore check: the relay role is refused a task title |
| A request forges the attribution of a sale | Sales takes the owner and source from its own projection, never from the body (strict schema); frozen on the first version | Sales e2e and unit tests; Phase 58 smoke: a body with `ownerId` gets `400` |
| An accepted quote wins an opportunity twice, or a replay reopens one | The inbox dedupes events; an opportunity converts once; a converted one refuses to reopen | Phase 58 unit and e2e tests (concurrent and repeated delivery) |
| A role does more than it may | `RequireCrmAction` on every route; `assign` checked for other people's tasks and owners; the screens hide what a role cannot do | `authorization.spec.ts`; smokes: a representative is refused settings, reassignment and tasks for others |
| A duplicate company is registered as a new prospect | The registry warns about lookalikes by name, email and phone before registering | Phase 54 smoke; browser workflow confirms the warning |

## Open items

- **Webhook delivery of CRM events.** The webhooks consumer dead-letters every event of a
  tenant it has not provisioned, whatever the module (found in Phase 57). Until that is
  fixed, `crm.task.due` does not reach a webhook in the demonstration workspace.
- **Record text naming an erased contact** stays readable until the account's party is
  erased (docs/privacy.md). A per-contact redaction would need its own design.
- **Backup key lifecycle.** As for every module, destroying a live key does not destroy it
  in a backup (docs/privacy.md).
- **Rate limits** rely on Kong's route limits.
