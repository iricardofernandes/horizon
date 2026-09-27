# Phase 57 — Activities, tasks, notes and reminders

Status: **delivered on 2026-09-27** ([evidence](crm-phase57-evidence.md)). This is the execution record for
[Phase 57 of the CRM plan](crm-implementation-plan.md#57--activities-tasks-notes-and-reminders).
Decisions: [ADR 0057](adr/0057-crm-accounts-are-parties-with-typed-documents.md).

## Result

After this phase, CRM keeps three new kinds of record next to an account:
- **activities** (call, meeting, email, visit) say what happened, when, and which
  contacts were there;
- **tasks** have an assignee, a due instant and an optional reminder. They are completed
  or cancelled, never deleted;
- **notes** are append-only revisions. A correction adds a revision, and the earlier text
  stays in the note's history.

It also adds:
- **reminders:** a scheduler inside the CRM service marks each reminder as sent once and
  publishes `crm.task.due`, which webhooks can deliver;
- **my agenda:** the caller's open tasks that are due or overdue;
- **timelines:** a read of an account or an opportunity that merges activities, tasks,
  notes and opportunity events in one order.

## Starting point

- CRM has accounts, contacts, owners, pipelines, lists and opportunities with an
  append-only history (Phases 55 and 56). The history is published as
  `crm.opportunity.*` (contracts 0.43.0).
- Contact fields are sealed under the contact's own key. Erasing a party shreds its
  contacts and blanks the account's names.
- The service runs an outbox relay as `horizon_relay`, the only role that reads across
  tenants, and only the outbox.
- Webhooks binds `#` and accepts any event its pinned contracts know.

## Decisions frozen by this plan

1. **Every record is attached to one subject: an account, a contact or an opportunity.**
   - The account is always stored as well. For a contact or an opportunity it is taken
     from the subject, never from the request.
   - A record is added only while the account is active. The subject must be live: a
     contact that is not erased, or an opportunity of that account.
   - An activity's participants are live contacts of the same account.
2. **Free text is sealed under a key of the account.**
   - Free text may name a person: an activity's title and summary, a task's title and a
     note's text.
   - The key is created with the account's first record. Erasing the party destroys it,
     so the append-only note revisions become unreadable without being rewritten
     (ADR 0026).
   - Erasing a contact removes it from nothing: a record keeps the id and reads it as an
     erased contact. Text that names the contact stays until the account is erased.
     This is recorded in docs/privacy.md.
   - Erasing a party also cancels the account's open tasks, so no reminder fires for it.
3. **Activities are corrected, not deleted.**
   - A person may revise an activity's kind, instant, participants, title or summary. An
     activity is in the past: an instant more than five minutes ahead is refused.
   - The audit log records which fields changed, never their values.
4. **Tasks.**
   - A task has a title, an assignee (an active owner), a due instant and an optional
     reminder instant, which cannot be later than the due instant.
   - It may be revised or reassigned while open, then completed or cancelled. Completing
     or cancelling is final.
   - Assigning a task to someone else needs the `assign` action. Assigning it to yourself
     needs `write`.
5. **Reminders fire once.**
   - A task whose reminder instant has passed and was not sent is claimed with
     `FOR UPDATE SKIP LOCKED` in its tenant's transaction.
   - `reminded_at` and the `crm.task.due` outbox row are written in the same transaction.
     A restart, or a second scheduler, finds nothing left to send.
   - Changing the reminder or due instant arms the reminder again. Only a task without a
     reminder instant never fires.
   - To find which tenants have work, the scheduler connects as `horizon_relay`. That role
     gains `SELECT` on four columns of `tasks` only: tenant, status, reminder instant and
     sent instant. It never reads a title.
6. **`crm.task.due` v1** carries the task and account ids, the subject, the assignee, and
   the due and reminder instants. It never carries the title.
7. **Timeline.**
   - It merges activities (at their instant), tasks (at creation, with their current
     state), notes (at creation, with the current text and revision count) and
     opportunity events (at their instant).
   - It is ordered newest first, with a stable tie-break by kind and id, and paginated by
     limit and offset in SQL.
   - An account's timeline includes the records of its contacts and opportunities, and the
     history of every opportunity of the account.
   - It is read inside the tenant transaction, like every other read, so RLS scopes it.
8. **My agenda** lists the caller's open tasks due up to `until` (default: 24 hours from
   now), ordered by due instant, each flagged as overdue or not.
9. **Notes can be corrected by anyone with `write`.** Tenant-wide visibility is the CRM
   rule (ADR 0023), and each revision records its author and instant.

## Work

### A — Contracts (0.44.0)

- `crm.task.due` v1 is added to `events/crm.ts`, the registry and the events catalogue.
- Every module is pinned to 0.44.0.

### B — CRM

1. **Domain:**
   - `Activity`, `Task` (open, completed, cancelled; reminder armed and sent) and `Note`
     (revisions);
   - value objects `Subject` (attachment), `ActivityKind` and `RecordText` (a single line
     or a long text that keeps its line breaks);
   - `TaskDue` domain event.
2. **Application:**
   - record and revise an activity;
   - create (idempotent), revise, reassign, complete and cancel a task;
   - write a note (idempotent) and correct it;
   - `FireDueReminders`, with a `DueReminderTenants` port;
   - the party erasure also cancels open tasks and shreds the account key.
3. **Migration `0002_activities`:**
   - `account_data_keys`, `activities`, `tasks`, `notes` and `note_revisions`, with
     `note_revisions` append-only by trigger;
   - forced RLS and column grants;
   - a narrow `reminder_scan` policy for `horizon_relay`.
4. **Infrastructure:**
   - an `AccountSealer` over the secret box;
   - the timeline and agenda reads;
   - a `ReminderWorker`, which runs when `DATABASE_RELAY_URL` is set, like the outbox
     relay (`REMINDER_POLL_INTERVAL_MS`, `REMINDER_BATCH_SIZE`).
5. **HTTP:**
   - `/activities` (`POST`, `PUT /:id`);
   - `/tasks` (list, `POST`, `PUT /:id`, `POST /:id/assignee`, `/complete`, `/cancel`);
   - `/notes` (`POST`, `GET /:id` with revisions, `POST /:id/revisions`);
   - `/agenda`;
   - `/accounts/:id/timeline` and `/opportunities/:id/timeline`.

### C — Evidence

1. Unit tests:
   - the task lifecycle and reminder arming;
   - note revisions;
   - subject resolution;
   - the use cases with the in-memory store;
   - the scheduler claiming each reminder once.
2. e2e on PostgreSQL:
   - text stored only as ciphertext and shredded with the party;
   - note revisions append-only;
   - two schedulers running at once, then a new scheduler, publish one `crm.task.due`;
   - the relay role cannot read a title;
   - the timeline ordered and tenant-scoped;
   - RLS on the new tables.
3. `scripts/phase57-smoke.mjs` through Kong:
   - an activity, a note corrected, and a task with a reminder;
   - the agenda;
   - the timeline of the opportunity and of the account;
   - `crm.task.due` read once from a probe queue, including after the CRM container is
     restarted.
4. `make check`, the CRM e2e, `make ci-local`, and isolated jobs for `crm` and
   `contracts`.

## Exit evidence

- A reminder fires once, even when the scheduler restarts or runs twice.
- The timeline is ordered and tenant-scoped.
- Correcting a note keeps the earlier text.

## Revisions made while implementing

- **Instants are checked field by field.** `2026-02-30T12:00:00Z` parsed as 2 March, so an
  invalid date was accepted. The API now refuses an instant whose calendar fields do not
  exist as written.
- **A timeline entry nests its record.** An activity has a `kind` of its own (call,
  meeting…), which overwrote the entry's kind (`activity`) when the two were flattened.
  An entry is now `{ kind, at, record }`. The e2e found it.
- **Webhooks rejects every event of the demonstration tenant.** The webhooks consumer
  records an event only for a tenant it has provisioned, and nothing in production code
  provisions one. Every event of an unknown tenant is dead-lettered, `crm.task.due`
  included. This predates the CRM and is left out of this phase: see the evidence.

## Out of scope

- Recurring tasks, calendar invitations and capturing email or calls (CRM plan, out of
  scope).
- Notifications other than the event: the screen's agenda comes in Phase 60.
- Attachments (files) on notes or activities.
