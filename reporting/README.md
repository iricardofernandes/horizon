# `reporting/`

Numbers that cross modules, as of a declared cutoff, and proven to agree with the modules
they came from.

An independently deployable NestJS service with its own database, its own container and
its own lifecycle. It is reached through Kong at `/reporting`, never directly, and it
shares no source with any other module (ADR 0001).

**Status: Phase 66.**
- The event journal, the producers' seals and the per-source watermarks.
- Four reports read from the journal at a cutoff, reconciled against the owners' own
  reports.
- Saved filters.
- Exports to CSV and XLSX, signed download links, and scheduled exports.
- Notifications from events, once per event, and saved views of list screens (Phase 66).

See the [production readiness plan](../docs/production-readiness-implementation-plan.md),
the [API reference](../docs/reporting-api.md) and
[ADR 0058](../docs/adr/0058-reporting-keeps-a-sealed-event-journal.md).

---

## What this context owns

- **The event journal:**
  - an append-only copy of every event of Sales, Financial, Treasury, Inventory,
    Procurement, Ledger, Catalog, CRM and Fiscal;
  - kept once per event id, with how it arrived (`live` or `replay`);
  - nothing of `parties.*` or `identity.*`, and procurement's `supplierName` removed
    before it is stored. A report holds ids, and names come from their owners.
- **Seals:** every count a producer sent of a tenant's events up to an instant, compared
  with the journal's own count: `matched`, `mismatched`, or `refused` when inside the
  two-minute margin.
- **Watermarks:** per tenant and source, how far the journal is proven complete. Only a
  matched seal moves it, and never backwards.
- **Reports** are queries over the journal at a cutoff, so there is no projection to drift
  or rebuild:
  - cash position;
  - order to cash;
  - procure to pay;
  - pipeline to revenue.
- **Reconciliation runs:** every check against an owner's own report, kept with its
  differences.
- **Saved filters:** private, or shared by an administrator.
- **Export jobs and schedules:**
  - reports written to CSV or XLSX in object storage by a worker, downloaded through
    links signed for 15 minutes, and removed after their retention;
  - schedules that run daily, weekly or monthly and catch up every missed run.

It never writes to another module (ADR 0047). It reads the owners' reports only for a
reconciliation, through the gateway, with the token of the person who asked.

## How events arrive

| Queue | Fed by | Prefetch |
|---|---|---|
| `reporting.events` | `horizon.events`, bound to every event type of the journaled modules | `AMQP_PREFETCH` |
| `reporting.notifications` | `horizon.events`, bound to the events that notify someone (Phase 66) | `AMQP_PREFETCH` |
| `reporting.replay` | a producer's `republish:journal`, through the default exchange | 1, so a seal is read after the events sent before it |

A message that cannot be parsed, or whose payload does not match its contract, goes to
the queue's `.dlq` at once. A failing write is retried once, then dead-lettered.

## API

| Method | Path | Roles | What it answers |
|---|---|---|---|
| `GET` | `/sources?cutoff=` | `admin`, `analyst`, `viewer` | Per source: events held, the latest one, the watermark, the last seal and whether the cutoff is settled; and whether it is settled for every source |
| `GET` | `/reports`, `/reports/{name}`, `/dashboard` | every role | The reports at a cutoff ([API reference](../docs/reporting-api.md)) |
| `POST` | `/reports/{name}/reconciliations` | `admin`, `analyst` | A reconciliation run at a settled cutoff |
| `POST`, `GET` | `/exports`, `/exports/{id}`, `/exports/{id}/link` | every role | Export jobs; `/exports/{id}/file` is public and checks the link's signature |
| `POST`, `GET`, `PATCH`, `DELETE` | `/export-schedules` | `admin`, `analyst` | Scheduled exports |
| `GET`, `POST`, `PATCH`, `DELETE` | `/saved-filters` | `admin`, `analyst` (sharing: `admin`) | Saved filters |
| `GET`, `POST` | `/notifications`, `/notifications/unread-count`, `/notifications/{id}/read`, `/notifications/read-all` | any signed-in user | Their notifications (Phase 66) |
| `GET`, `POST`, `PATCH`, `DELETE` | `/views` | any signed-in user | Saved views; only the owner changes one |
| `GET` | `/health/live`, `/health/ready` | public | Liveness, and readiness with a database ping |

## Filling the journal from a producer's history

In `sales/`, `financial/`, `treasury/`, `inventory/`, `procurement/`, `ledger/` or `crm/`:

```bash
npm run republish:journal -- --tenant <uuid> [--since <iso>] [--until <iso>] [--seal-only]
```

The command:
- reads the tenant's outbox as the relay role;
- resends each row unchanged to `reporting.replay`;
- then seals the count up to `--until`, which defaults to two minutes ago.

Running it again changes nothing. Each of those producers also seals every tenant by
itself every `JOURNAL_SEAL_INTERVAL_MS` (five minutes by default).

## Running it

```bash
cp .env.example .env
npm ci
npm run db:migrate   # as horizon_owner
npm run dev
npm test             # unit tests, coverage gate on domain/ and application/
npm run test:e2e     # PostgreSQL and RabbitMQ in Testcontainers
```

## Audit log (Phase 68)

`GET /audit` reads the tenant's hash-chained log a page at a time, newest first, filtered
by actor, action, record and period. Every page carries the chain's verdict: each row is
recomputed and checked against its neighbours, so a tampered row reads as broken. Read by
admins; the web's audit screen asks it alongside every other module.
