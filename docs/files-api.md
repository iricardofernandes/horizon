# Files API reference

Attachments on the records of other modules
([ADR 0060](adr/0060-attachments-are-a-files-module.md),
[Phase 65 plan](readiness-phase65-implementation-plan.md)). The shapes are published in
`@horizon/contracts` 0.48.0 (`http/files.ts`, `events/files.ts`).
- **Path:** through Kong, every path below is prefixed with `/files`.
- **Roles:** `files` has none. The owning module's role, read from the token, decides:

  | Module | Record types | Read (list, one, link) | Write (slot, delete) |
  |---|---|---|---|
  | `parties` | `party` | admin, editor, viewer | admin, editor |
  | `procurement` | `purchase-order` | admin, buyer, approver, viewer | admin, buyer |
  | `financial` | `receivable`, `payable` | admin, operator, viewer | admin, operator |
  | `sales` | `service-order` | admin, representative, viewer | admin, representative |
  | `crm` | `opportunity` | admin, manager, representative, viewer | admin, manager, representative |
- **Limits:** 10 MiB per file. The accepted types are PDF, PNG, JPEG, GIF, WebP, plain
  text, CSV, DOCX and XLSX.

## Routes

| Route | Needs | Does |
|---|---|---|
| `GET /record-types` | a token | the attachable record types, their retention, and what the caller may do on each |
| `POST /attachments` | write role, `Idempotency-Key` | asks for an upload slot: `201` with the attachment and a `PUT` link |
| `PUT /uploads/{id}?tenant=&expires=&signature=` | the signature | the file's bytes, with its declared content type |
| `GET /attachments?module=&recordType=&recordId=` | read role | the record's attachments that are scanning, available or quarantined |
| `GET /attachments/{id}` | read role | one attachment |
| `GET /attachments/{id}/link` | read role | a download link valid for 5 minutes; `409` unless available |
| `GET /attachments/{id}/content?tenant=&expires=&signature=` | the signature | the decrypted file, while it is available |
| `DELETE /attachments/{id}` | write role | ends it as `removed`, and removes its bytes |

## Uploading

```http
POST /files/attachments
Idempotency-Key: 5d0c…
Content-Type: application/json

{ "module": "financial", "recordType": "payable", "recordId": "…",
  "fileName": "boleto-setembro.pdf", "contentType": "application/pdf", "size": 48213,
  "ownerPartyId": "…" }
```

```json
{ "attachment": { "id": "…", "status": "uploading", … },
  "upload": { "method": "PUT", "url": "/files/uploads/…?tenant=…&expires=…&signature=…",
              "expiresAt": "…" } }
```

- **The slot request.**
  - The same key and body answer the same slot. The same key with another body is `409`.
  - `ownerPartyId` names the party the record is about, and its erasure shreds the file.
    For a party record, the party itself is the owner. Without it, the uploader is.
- **The `PUT`** carries the raw bytes. It is refused with `400` unless:
  - the length is the declared size;
  - the `Content-Type` is the declared type;
  - the first bytes match it: `%PDF-`, the PNG, JPEG, GIF or WebP signature, a ZIP header
    for DOCX and XLSX, or UTF-8 without NUL for text and CSV.
- **The link** is valid for 15 minutes, and a slot not used within an hour is abandoned.

## States

`uploading → scanning → available | quarantined → deleted`

- `scanning`: the upload tries the scan at once. A scanner without an answer leaves the
  file here, and the worker tries again every 30 seconds.
- `available`: only now can a download link be taken.
- `quarantined`: `finding` names what the scanner found. The bytes were removed at once.
  After 30 days it ends as `quarantined`.
- `deleted`, with `deletionReason`:
  - `removed` (a person);
  - `expired` (retention);
  - `erased` (the owner's key was destroyed);
  - `quarantined`;
  - `abandoned`.

## Downloading

`GET /attachments/{id}/link` answers `{ method: "GET", url, expiresAt }`. The content route
answers the decrypted file with:
- `Content-Disposition: attachment`, with an ASCII name and a UTF-8 `filename*`;
- `X-Content-Type-Options: nosniff`;
- `Content-Security-Policy: sandbox; default-src 'none'`;
- `Digest: sha-256=…`.

It answers `404` once the file is no longer available, whatever the link.

## Retention

Retention is counted from when the file became available:

| Record type | Kept for |
|---|---|
| `party` | until the party is erased |
| `purchase-order`, `receivable`, `payable`, `service-order` | 1,826 days (5 years) |
| `opportunity` | 730 days (2 years) |

Every removal of stored bytes is logged in `attachment_removals` with its reason, and
that log is append-only.

## Encryption and erasure

- **Keys.** Each file has its own data key (AES-256-GCM), wrapped by its owner's key. The
  owner's key is itself wrapped by `FILES_MASTER_KEY`. The tenant, owner and attachment
  are bound as associated data.
- **Erasure.**
  - `parties.party.erased` erases a party owner; `identity.data-subject.erased` erases a
    user owner.
  - Either one destroys the owner's key and ends that owner's files as `erased`, once per
    event.
  - Their bytes cannot be decrypted from then on, and the worker removes them.
  - An erased owner takes no new attachment (`409`).

## Events

Each event carries the attachment, module, record type and record id, and **never the
file name**:
- `files.attachment.available`, with the content type and size;
- `files.attachment.quarantined`;
- `files.attachment.deleted`, with the reason.
