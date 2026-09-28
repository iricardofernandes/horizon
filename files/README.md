# `files/`

Attachments on the records of other modules: scanned before they are served, encrypted
under their owner's key, and shredded with it.

An independently deployable NestJS service with its own database, its own bucket, its own
container and its own lifecycle. It is reached through Kong at `/files`, never directly,
and it shares no source with any other module (ADR 0001).

**Status: Phase 65.** See the [Phase 65 plan](../docs/readiness-phase65-implementation-plan.md),
the [API reference](../docs/files-api.md) and
[ADR 0060](../docs/adr/0060-attachments-are-a-files-module.md).

---

## What this context owns

- **Attachments.** Each one names a record as `(module, recordType, recordId)` and follows
  the lifecycle `uploading → scanning → available | quarantined → deleted`:

  | Module | Record types | Kept after it is available |
  |---|---|---|
  | `parties` | `party` | until the party is erased |
  | `procurement` | `purchase-order` | 5 years |
  | `financial` | `receivable`, `payable` | 5 years |
  | `sales` | `service-order` | 5 years |
  | `crm` | `opportunity` | 2 years |
- **Owner keys.** One per party or user, wrapped by `FILES_MASTER_KEY`. Each file has its
  own data key, wrapped by its owner's key. Erasing the owner sets the key to null, and a
  trigger never lets it come back.
- **Removals.** Every removal of stored bytes: who, why, how many bytes, and when. The
  table is append-only.
- **The audit log.** A hash chain of who asked for a slot, took a download link, or
  deleted a file (ADR 0025).

It holds no roles of its own (ADR 0060). The owning module's role, read from the token,
says who reads or attaches:

| Module | Reads | Writes |
|---|---|---|
| `parties` | admin, editor, viewer | admin, editor |
| `procurement` | admin, buyer, approver, viewer | admin, buyer |
| `financial` | admin, operator, viewer | admin, operator |
| `sales` | admin, representative, viewer | admin, representative |
| `crm` | admin, manager, representative, viewer | admin, manager, representative |

## Events

- **Consumed** on `files.erasures`: `parties.party.erased` and
  `identity.data-subject.erased`. Each one destroys the owner's key and ends that owner's
  files, in the same transaction as its inbox row.
- **Published** through the outbox:
  - `files.attachment.available`;
  - `files.attachment.quarantined`;
  - `files.attachment.deleted`.

  They carry the record and never the file name.

## Scanning

`FILES_SCANNER` chooses the port's adapter:
- **`eicar`** (the default, and CI): it flags the EICAR test string, and nothing else.
- **`clamav`:** `clamd` over TCP (`INSTREAM`). Locally it runs with `make up-scanner`.

A scan with no answer leaves the file `scanning`, and the worker tries again every
`FILES_SCAN_RETRY_MS`.

## The worker

It runs when `DATABASE_RELAY_URL` is set.
- It asks, as the relay role, which tenants have rows whose `due_at` has passed. That role
  reads only `tenant_id` and `due_at`.
- For each due row, it:
  - abandons an unused slot;
  - scans again;
  - expires by retention;
  - removes stored bytes and logs the removal;
  - ends a quarantine after 30 days.

## Local development

```bash
cp .env.example .env
npm ci
npm run db:migrate
npm run dev
```

Tests:
- `npm test` runs the unit tests, with in-memory fakes;
- `npm run test:e2e` runs the e2e suite against PostgreSQL and RabbitMQ in Testcontainers.
