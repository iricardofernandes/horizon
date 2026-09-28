# Phase 65 — Attachments

Status: **delivered on 2026-09-28** ([evidence](readiness-phase65-evidence.md)). This is the execution record for
[Phase 65 of the production readiness plan](production-readiness-implementation-plan.md#65--attachments).
Decision: [ADR 0060](adr/0060-attachments-are-a-files-module.md).

## Result

After this phase:
- **A new module, `files/`,** runs on port 3014 behind `/files`. It has its own database,
  `horizon_files`, and its own bucket, `horizon-attachments`.
- **Five records take attachments:**

  | Module | Record type | Screen |
  |---|---|---|
  | Parties | `party` | the party's details |
  | Procurement | `purchase-order` | the purchase order dialog |
  | Financial | `receivable`, `payable` | the title's details |
  | Sales | `service-order` | the service order dialog |
  | CRM | `opportunity` | the opportunity dialog |
- **The lifecycle.** A file is uploaded through a signed link, then scanned, then either
  served or quarantined.
  - A quarantined file is never served, and its bytes are removed.
  - A file whose scan could not run stays `scanning` until a scan succeeds.
- **Encryption.** Every file is encrypted with its own key, wrapped by its owner's key:
  - the party it is about;
  - otherwise, the user who uploaded it.

  Erasing the owner destroys that key, so the bytes left in storage can no longer be
  decrypted.
- **Retention.** It is declared per record type. A job expires what is due and logs every
  removal.

## Starting point

- **Object storage.** MinIO holds Fiscal's artifacts and Reporting's exports. The bucket
  setup (`minio-init`) creates a bucket per use, versioned.
- **Signed links.** Reporting's export download (Phase 63) is an HMAC-signed path, valid
  for 15 minutes and public. The signature, not a token, says who may open it.
- **Crypto-shredding.**
  - Parties seals personal fields under a key per party, and erasing destroys the key
    (ADR 0026).
  - CRM does the same per contact.
  - Both publish or consume `parties.party.erased`. Identity publishes
    `identity.data-subject.erased` for a user.
- **Authorization.** Every module maps its own roles to actions (ADR 0023). `files` holds
  no roles (ADR 0060), so it must read the owning module's role from the token.
- **The gateway** limits request bodies to 8 MB, globally.
- **The web proxy** (`/api/horizon/<module>/…`) forwards the body, the content type, the
  idempotency key, and the download headers.

## Decisions frozen by this plan

1. **The contract (`@horizon/contracts` 0.48.0).**
   - `http/files.ts` holds:
     - the states;
     - the attachable record types per module;
     - the accepted content types;
     - the size limit;
     - the attachment, upload slot and link shapes.
   - `events/files.ts` holds the events:
     - `files.attachment.available`;
     - `files.attachment.quarantined`;
     - `files.attachment.deleted`, with the reason.

     They carry the record reference, the size and the content type, and **never the
     file name**. A name is personal data as often as not ("atestado-joao-silva.pdf").
   - `files` stays out of `MODULES`: it has no roles (ADR 0060).
2. **The lifecycle:** `uploading → scanning → available | quarantined → deleted`.
   - `uploading`: a slot was asked for, and the bytes have not arrived. A slot not used
     within an hour is deleted as `abandoned`.
   - `scanning`: the bytes are stored, encrypted, and the scan has not answered. The
     upload tries the scan at once. If it fails, a worker tries again every 30 seconds.
     A scanner failure never releases the file.
   - `available`: clean, and served through a signed link.
   - `quarantined`: the scanner found something. The bytes are removed at once and never
     served. The row keeps the signature name for 30 days, then becomes `deleted`.
   - `deleted`, with the reason: `removed` (a person), `expired` (retention), `erased`
     (the owner's key was destroyed), `quarantined` or `abandoned`.
3. **Upload through a signed link.**
   1. `POST /attachments` asks for a slot. It needs the owning module's write role and an
      `Idempotency-Key`. The body is `{ module, recordType, recordId, fileName,
      contentType, size, ownerPartyId? }`.
      - The type must be on the allow-list, and the size at most 10 MiB.
      - The answer is the attachment, still `uploading`, and a `PUT` link valid for 15
        minutes.
      - The same key with the same body returns the same slot. The same key with another
        body is `409`.
   2. `PUT /uploads/{id}?tenant=…&expires=…&signature=…` carries the raw bytes. It is
      public: the signature binds the tenant, the attachment and the expiry.
      - It is refused unless the length is the declared size and the content type is the
        declared one.
      - The first bytes must match the type: `%PDF` for PDF, the PNG, JPEG, GIF and WebP
        signatures, and a ZIP header for the Office formats. Text (plain text and CSV)
        must be valid UTF-8 without NUL.
      - The bytes are hashed, encrypted, stored and scanned.
   - **Accepted types:** PDF, PNG, JPEG, GIF, WebP, plain text, CSV, DOCX, XLSX.
     Anything else is refused, including HTML and SVG, which a browser would run.
4. **Download through a signed link.**
   - `GET /attachments/{id}/link` needs the module's read role. It answers a link valid
     for 5 minutes, and only for an `available` file.
   - `GET /attachments/{id}/content?…` is public. It checks the signature and that the
     file is still available, then decrypts and streams it:
     - `Content-Disposition: attachment` with the name, reduced to safe characters;
     - `X-Content-Type-Options: nosniff`;
     - `Content-Security-Policy: sandbox`;
     - the digest header.
5. **Who may do what (ADR 0060, 0023).** `files` holds a static map of the owning
   modules' roles:

   | Module | Read (list, link) | Write (upload, delete) |
   |---|---|---|
   | Parties | admin, editor, viewer | admin, editor |
   | Procurement | admin, buyer, approver, viewer | admin, buyer |
   | Financial | admin, operator, viewer | admin, operator |
   | Sales | admin, representative, viewer | admin, representative |
   | CRM | admin, manager, representative, viewer | admin, manager, representative |

   - The map follows each module's own map for the record's subject. `fiscal-reader`
     reads no attachment.
   - A user without the role is refused with `403`, before anything is read.
   - An attachment of another tenant is invisible through RLS. `files` cannot prove a
     record exists (ADR 0060), and an attachment to a mistyped id is harmless.
6. **Encryption (envelope, AES-256-GCM).**
   - **Three keys:**
     - the **master key** (`FILES_MASTER_KEY`, 32 bytes) wraps the owner keys, and lives
       only in the environment;
     - the **owner key** (`owner_keys`), one per `(tenant, party | user)`, is stored
       wrapped;
     - the **data key** is random per file, stored wrapped by the owner key.
   - The object is `version ‖ nonce ‖ ciphertext ‖ tag`, with the tenant and attachment as
     associated data. An object moved to another attachment does not open.
   - **The owner:**
     - for a party, the party itself;
     - otherwise, `ownerPartyId` when the screen knows the record's party (the supplier,
       the title's party, the service order's customer, the opportunity's account);
     - otherwise, the uploader.

     The owner only decides which erasure shreds the file. A wrong party given by a
     caller with write access changes nothing else.
   - **Erasure.**
     - `parties.party.erased` and `identity.data-subject.erased` destroy the owner key
       (`wrapped_key` set to null, which a trigger never lets come back).
     - Every attachment of that owner becomes `deleted` (`erased`), with its event, in
       the same transaction as the inbox row.
     - An erased owner can take no new attachment.
7. **Retention per record type,** counted from when the file became available:

   | Record type | Kept for |
   |---|---|
   | `party` | until the party is erased |
   | `purchase-order`, `receivable`, `payable`, `service-order` | 5 years (1,826 days), the tax-record period |
   | `opportunity` | 2 years (730 days) |

   Expiry is a job:
   - `due_at` on each row says when the worker must look at it next:
     - the slot's expiry;
     - the scan retry;
     - the retention end;
     - the quarantine end;
     - now, for bytes to remove.
   - The worker finds tenants with due rows as the relay role, which reads only
     `tenant_id` and `due_at`.
   - It claims rows with `FOR UPDATE SKIP LOCKED` and acts on each.
   - Every object it removes is logged in `attachment_removals` (attachment, record,
     reason, bytes, when). That table is append-only.
8. **The scanner is a port** (`FILES_SCANNER`).
   - `eicar`, deterministic, for CI and tests: it flags the EICAR test string.
   - `clamav` talks to `clamd` over TCP with `INSTREAM`.
     - It runs locally with `make up-scanner`, under the Compose profile `scanner`.
     - It stays out of the default stack and of CI because its signature download is
       large and often refused from cloud runners.
9. **Stored data** (`horizon_files`), all with forced RLS:
   - `attachments`: the record reference, the name, the type and size, the SHA-256, the
     status, the reason and scanner verdict, the owner, the wrapped data key, the object
     key and `due_at`;
   - `owner_keys`;
   - `attachment_removals`;
   - `audit_log`, hash-chained (ADR 0025): who asked for a slot, deleted a file or took a
     download link;
   - `outbox` and `inbox`.
10. **The web.**
    - One `AttachmentsPanel` component, placed in the five screens. It lists the files,
      uploads one (a slot, then the bytes to the signed link), follows the scan, opens a
      download link, and deletes.
    - It is in pt-BR and English.
    - The proxy gains the `files` root.

## Work

### A — Contracts
1. `http/files.ts` and `events/files.ts`, with tests.
2. Release 0.48.0 and repin every consumer.

### B — `files/`
1. The skeleton, copied from `reporting/`: configuration, telemetry, token verification,
   Docker and README.
2. **Domain:**
   - the attachment, its states and transitions;
   - the record types and their retention;
   - the role map;
   - the type allow-list and the sniffing of first bytes;
   - the safe file name.
3. **Application:**
   - request a slot, receive the bytes, scan, list, find, sign a link, read content,
     delete;
   - the worker's pass;
   - the erasure handlers.
4. **Infrastructure:**
   - the SQL store and its migration;
   - the envelope cipher;
   - the object stores (S3 and a directory);
   - the scanners;
   - the signed links;
   - the controller;
   - the outbox relay, the consumer and the worker.
5. **Tests:**
   - unit tests of the domain and the application;
   - e2e against PostgreSQL and RabbitMQ:
     - upload to available;
     - EICAR quarantined;
     - erasure;
     - RLS across tenants;
     - the relay role;
     - expiry and its log.

### C — The platform
1. `scripts/modules.json`, `Makefile`, the Postgres init script, Compose (the service, its
   migration, the bucket, and the `scanner` profile), and Kong (the `/files` route, 11 MB
   for its bodies).
2. The CI workflows (isolation, release and golden-path diagnostics), and the local CI
   list.

### D — The web
1. The proxy root, the `AttachmentsPanel`, and its messages.
2. The panel in the five screens.

### E — Evidence
1. `scripts/phase65-smoke.mjs`, through Kong:
   - a PDF becomes available and downloads intact;
   - EICAR is quarantined and its link refused;
   - a role-less user gets `403`;
   - another tenant sees nothing;
   - erasing a party makes its attachment unreadable.
2. One run with ClamAV.
3. The evidence record, the API reference, the glossary, the README and the plan status.

## Exit evidence

- The EICAR file is quarantined and never served.
- An attachment of an erased party cannot be decrypted.
- A user without the owning module's role cannot list or read its attachments.
- A cross-tenant read returns nothing.

## Revisions made while implementing

- **The domain vocabulary.** The domain keeps its own lists of record types, states,
  reasons and types, because ADR 0002 forbids it `@horizon/contracts`. A test keeps them
  equal to the contract.
- **Claiming due rows.** The worker claims due rows by moving their `due_at` forward
  (`FILES_CLAIM_MS`). Another worker skips them, and a worker that dies leaves them due
  again. Every transition is also conditional on the row being unchanged.
- **Backups.** Erasure makes the stored bytes unreadable, but a backup of `owner_keys`
  from before it is not shredded. That backup's retention is Phase 69's concern.
- **The unversioned bucket.** `horizon-attachments` is the only unversioned bucket, so
  that a removal is real.

