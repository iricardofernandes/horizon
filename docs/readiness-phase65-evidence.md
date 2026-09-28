# Phase 65 — evidence: attachments

Status: **delivered on 2026-09-28** (local runs between 14:00 and 14:30 UTC).
Plan: [readiness-phase65-implementation-plan.md](readiness-phase65-implementation-plan.md).
Decision: [ADR 0060](adr/0060-attachments-are-a-files-module.md).
API: [files-api.md](files-api.md).

## What was delivered

- **The contract.**
  - `@horizon/contracts` 0.48.0 publishes, in `http/files.ts`:
    - the states;
    - the attachable record types per module;
    - the accepted types;
    - the 10 MiB limit;
    - the request, attachment and link shapes.
  - It publishes three events in `events/files.ts`: `files.attachment.available`,
    `…quarantined` and `…deleted`.
  - Every consumer is pinned to 0.48.0.
- **`files/`, a new service on port 3014, behind `/files`.**
  - **Storage:** its database, `horizon_files`, and its bucket, `horizon-attachments`
    (not versioned).
  - **Messaging:** an outbox and an inbox.
  - **The worker:** it finds its tenants as the relay role.
  - **Its tables:**
    - `attachments`;
    - `owner_keys`;
    - `attachment_removals`, append-only;
    - `audit_log`, hash-chained;
    - `outbox` and `inbox`.

    All of them have forced RLS.
- **Uploads and downloads.**
  - An upload goes through a signed `PUT` link, valid for 15 minutes. It is checked
    against the declared size, type and first bytes.
  - It is encrypted with its own key under the owner's key, then scanned. It is served
    only when clean, through a `GET` link signed for 5 minutes, with `nosniff`, a
    sandboxing CSP and `attachment` disposition.
- **The scanner port.**
  - The deterministic EICAR adapter is the default, and what CI uses.
  - `clamd` over TCP runs with `make up-scanner`, under the Compose profile `scanner`.
- **Erasure.**
  - `parties.party.erased` and `identity.data-subject.erased` destroy the owner's key and
    end its files, once per event.
  - The worker removes their bytes, and logs each removal.
- **Retention.**
  - Declared per record type: party files until erasure, tax records 5 years,
    opportunities 2 years.
  - An expiry job ends due files and logs every removal.
- **The web.** An attachments panel on parties, purchase orders, receivables and payables,
  service orders and opportunities, in pt-BR and English. The proxy gained the `files`
  root.
- **The platform.**
  - It appears in `modules.json`, the Makefile and the Postgres init.
  - Compose runs the service, its migration, the bucket and the ClamAV profile.
  - Kong routes `/files`, with an 11 MB body limit on that route.
  - The CI workflows cover it: isolation, release and golden-path diagnostics, and the
    local CI list.

## Exit criteria

| Criterion | Evidence |
|---|---|
| The EICAR file is quarantined and never served | **Smoke, with both scanners:** `quarantined` with the finding `Eicar-Test-Signature`. Its link is `409`, and another file's link edited to point at it is `403`. The removal is logged as `quarantined:68`, and nothing is left in MinIO. With ClamAV the daemon logged `instream(…): Eicar-Test-Signature FOUND`. **e2e:** quarantined, its bytes gone, and deleting its removal log refused (`append-only`) |
| An attachment of an erased party cannot be decrypted | **Smoke:** `DELETE /parties/parties/{id}` reaches `files` through RabbitMQ. The party's key is null, both of its attachments (a PDF on the party, a PNG on a payable) end as `erased`, an old link answers `404`, a new slot is `409`, and both objects are removed and logged. **e2e:** every key left in the database is tried against the stored bytes and none opens them, a key cannot be restored (trigger), and the event handled twice ends the files once |
| A user without the owning module's role cannot list or read its attachments | **Smoke:** a user with `catalog:admin` and `parties:fiscal-reader` gets `403` on list, one, link and slot. A `parties:viewer` lists but gets `403` on slot and delete. **Unit:** the role map of all five modules |
| A cross-tenant read returns nothing | **Smoke:** another tenant's admin gets `404` on the attachment and on its link, and an empty list for the same record. **e2e:** `find`, `list` and `content` of another tenant are empty under RLS |

## Smoke (`node scripts/phase65-smoke.mjs [--scanner clamav]`)

It runs in a fresh workspace each time. Both runs passed: the default EICAR adapter, and
ClamAV 1.4.6.

| Step | Result |
|---|---|
| A PDF on a party | `available`, no retention end. It downloads byte for byte, with `nosniff` and a safe name for "Contrato social – Fornecedor.pdf". The MinIO object holds no plaintext |
| A PNG on a payable, through the web proxy | `available`, with 5.00 years of retention, and it downloads through the proxy |
| EICAR | quarantined, removed and never served (above) |
| Declarations | `400` each for over 10 MiB, `text/html`, bytes that are not a PDF, and a type other than the declared one |
| Roles | `403` without the module role; a viewer lists but cannot attach or delete |
| Tenancy | another tenant gets `404` / `404` / an empty list |
| Removal by a person | `deleted` (`removed`), logged |
| Erasure | key destroyed, attachments unreadable and removed (above) |
| Events | 9 published, none carrying a file name, and the outbox drained |
| Web | the payables page answers `200` |

The panel was also driven in Chromium as the demo operator:
1. the party's "Attachments" dialog;
2. "Attach a file" with a PDF;
3. the file listed as `available`;
4. the download saved it with its name.

## Tests

- **Contracts:** 8 new tests:
  - the record types per module;
  - the types a browser would run are refused;
  - the size limit;
  - every state;
  - links only inside `files`;
  - events without a name.
- **`files` unit tests:** 53. The domain and application layers are covered at 92.6% of
  statements, above the 80% gate. They cover:
  - the lifecycle and its refusals;
  - the first-byte checks and safe names;
  - retention and roles;
  - idempotent slots;
  - quarantine, a scan without an answer, and retries;
  - removal, and bytes left for the worker;
  - abandonment, expiry, the quarantine end, and batches;
  - erasure once per event;
  - the envelope, which opens nothing under another owner, attachment, tenant or master
    key, and refuses tampered bytes;
  - the clamd framing and verdicts, against a fake daemon over TCP;
  - signed links;
  - the domain vocabulary equal to the contract.
- **`files` e2e against PostgreSQL and RabbitMQ:** 8 tests:
  - ciphertext at rest;
  - the audit chain;
  - EICAR;
  - erasure, both by the use case and by the event delivered twice;
  - tenancy;
  - the relay role, which reads only `tenant_id` and `due_at`;
  - the outbox publishing without the name.
- **Web:** 5 new unit tests: types, refusals, the slot request, abilities, the proxy path,
  and sizes. The copy check passes.

## Findings along the way

- **The domain may not import `@horizon/contracts` (ADR 0002).** The domain has its own
  vocabulary (`domain/vocabulary.ts`), and a test keeps it equal to the contract. The
  published view lives in `infrastructure/http/views.ts`.
- **Crypto-shredding does not reach a database backup.** A backup of `owner_keys` taken
  before the erasure still holds the wrapped key. The plan's claim "including backups" was
  removed. Phase 69 must keep the key table's backups within the erasure window, or
  re-shred on restore.
- **A versioned bucket would keep "removed" bytes as old versions.** `horizon-attachments`
  is the one bucket left unversioned.
- **Kong keeps the old address of a recreated container.** After `files` is recreated
  alone, Kong answers `502` until it restarts, as `make up-apps` and `make up-scanner` do.
- **The ClamAV image ships its signatures,** so clamd was healthy in seconds locally. CI
  still uses the EICAR adapter, because a signature refresh is often refused from cloud
  runners.

## Verification

- `make check`: passed.
- `files`: `npm test` (53), `npm run test:e2e` (8) and `test:cov` passed.
- `contracts`: 136 tests; 0.48.0 published to the local registry; `docs/events.md` and
  `published-schemas.json` regenerated.
- The smoke passed with EICAR and with ClamAV.
