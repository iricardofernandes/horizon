# `reporting/`

Numbers that cross modules, as of a declared cutoff, and proven to agree with the modules
they came from.

An independently deployable NestJS service with its own database, its own container and
its own lifecycle. It is reached through Kong at `/reporting`, never directly, and it
shares no source with any other module (ADR 0001).

**Status: Phase 62.**
- The event journal, the producers' seals and the per-source watermarks.
- Four reports read from the journal at a cutoff, reconciled against the owners' own
  reports.
- Saved filters.

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

It never writes to another module (ADR 0047). It reads the owners' reports only for a
reconciliation, through the gateway, with the token of the person who asked.

## How events arrive

| Queue | Fed by | Prefetch |
|---|---|---|
| `reporting.events` | `horizon.events`, bound to every event type of the journaled modules | `AMQP_PREFETCH` |
| `reporting.replay` | a producer's `republish:journal`, through the default exchange | 1, so a seal is read after the events sent before it |

A message that cannot be parsed, or whose payload does not match its contract, goes to
the queue's `.dlq` at once. A failing write is retried once, then dead-lettered.

## API

| Method | Path | Roles | What it answers |
|---|---|---|---|
| `GET` | `/sources?cutoff=` | `admin`, `analyst`, `viewer` | Per source: events held, the latest one, the watermark, the last seal and whether the cutoff is settled; and whether it is settled for every source |
| `GET` | `/reports`, `/reports/{name}`, `/dashboard` | every role | The reports at a cutoff ([API reference](../docs/reporting-api.md)) |
| `POST` | `/reports/{name}/reconciliations` | `admin`, `analyst` | A reconciliation run at a settled cutoff |
| `GET`, `POST`, `PATCH`, `DELETE` | `/saved-filters` | `admin`, `analyst` (sharing: `admin`) | Saved filters |
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
