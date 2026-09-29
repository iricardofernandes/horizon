# Phase 74 — The document index, one partition per tenant

Status: **delivered on 2026-09-29** ([evidence](ai-phase74-evidence.md)). This is the execution record for
[Phase 74 of the AI with isolation plan](ai-implementation-plan.md#74--the-document-index-one-partition-per-tenant),
built on ADR 0067 (one partition per tenant), ADR 0068 (derived data follows its source) and
ADR 0069 (models are ports).

## Result

After this phase:
- **`knowledge/`** runs on port 3016 behind `/knowledge`, with the database
  `horizon_knowledge`.
- **Indexing:**
  - it listens to `files.attachment.available`, reads the file through `files/` with its
    own service identity, and extracts the text;
  - it indexes plain text, CSV, PDF text layers, XLSX and DOCX;
  - it chunks the text, embeds it, seals it, and writes the chunks into its tenant's own
    partition, which has its own HNSW index.
- **Leaving the index:** `files.attachment.deleted` removes a file's vectors and destroys its
  key, whatever the reason:
  - removed, expired, erased with its owner, quarantined or abandoned;
  - a tombstone then refuses a late or replayed `available`.
- **Models:** a deterministic hash embedder is the default and runs in CI. The stack's `ai`
  profile runs `multilingual-e5-small` on Text Embeddings Inference, and each partition's
  chunks carry the index version they were embedded with.
- **The cluster:** PostgreSQL gains pgvector, in the same Alpine image the platform already
  runs.

## Starting point

- **`files/` publishes the three attachment events** without file names. Erasing a party
  or a user already ends every attachment it owns with its own
  `files.attachment.deleted (erased)`.
- **Reading a file** takes a role in the owning module (`files/` `permits`). The bytes come
  through a five-minute signed link.
- **Phase 69 gave scheduled work a service identity:** a named client proves its secret to
  Identity and receives a short token for one tenant. Its roles are fixed in
  `SERVICE_GRANTS`.
- **PostgreSQL is `postgres:17-alpine`,** with `en_US.utf8` under musl. The official
  pgvector image is Debian (glibc), where the same locale collates differently.
- **Attachable types:** PDF, PNG, JPEG, GIF, WebP, plain text, CSV, DOCX and XLSX. Fiscal
  XML is not an attachment type.

## Decisions frozen by this plan

1. **pgvector is built into the platform's own image.**
   - `infra/postgres/Dockerfile` is `postgres:17-alpine` plus pgvector 0.8.1, compiled
     without LLVM.
   - Compose, the backup job and the restore drill use it.
   - Moving to the Debian image would change string collation under existing B-tree
     indexes: a reindex of every database for no gain.
2. **A key per attachment, not per owner** (a revision of ADR 0068).
   - Every erasure reaches `knowledge/` as one `files.attachment.deleted` per attachment,
     because `files/` ends each file of an erased owner.
   - So each document's text is sealed under its own data key, wrapped by
     `KNOWLEDGE_MASTER_KEY`.
   - Deletion destroys the key, deletes the chunks and leaves the document row as a
     tombstone. The module does not need to know owners, nor to listen to the parties and
     identity erasure events itself.
3. **`knowledge` is a service client with read roles** in the five attaching modules, the
   only modules with attachments.
   - It reads a file exactly as a person with a viewer role would: attachment, link, bytes.
   - It holds that grant only to index. Search (Phase 75) answers with the caller's own
     roles.
4. **The schema:**
   - `documents`, one row per attachment: state, content digest, index version, wrapped
     key, due time and attempts;
   - `chunks PARTITION BY LIST (tenant_id)`.
   - A `SECURITY DEFINER` function owned by the migration role creates a tenant's partition
     on first use, with its HNSW index (`vector_cosine_ops`) and forced RLS. It revokes
     direct access, so the application reads only through the parent.
   - Forced RLS applies on every table.
5. **Indexing is a worker, not the consumer.**
   - The consumer records `pending` with the inbox claim, in one transaction.
   - A worker finds due documents across tenants as the relay role (it reads only
     `tenant_id` and `due_at`), claims them with `SKIP LOCKED`, and writes all of a
     document's chunks in one transaction. So a crash leaves either no chunk or every chunk.
   - A failure retries with backoff, up to five attempts. A file with no text (an image, a
     scanned PDF) ends `no-text`, not failed.
6. **Chunks:** about 800 characters with a 100-character overlap, cut on whitespace, and at
   most 400 chunks per document. The rest is recorded as truncated.
7. **Embeddings:**
   - 384 dimensions for both embedders;
   - `hash-384-v1` hashes tokens with a sign, then L2-normalises (lexical and
     deterministic);
   - `e5-small-v1` calls TEI with the `passage:` prefix.

   Documents embedded with another version are due again, and re-index in the background.
8. **Metrics:** `knowledge_index_lag_seconds` (oldest due), `knowledge_documents` by state,
   and `knowledge_embedding_seconds`. There is no tenant label.

## Work

1. **The image:** `infra/postgres/Dockerfile`, then compose, the backup job and the restore
   drill.
2. **`knowledge/`:**
   - the project and its migration (tables, partitioned chunks, the partition function,
     RLS, relay grants);
   - the consumer and inbox, the worker, extraction, chunking, the two embedders and
     sealing;
   - a status route for the workspace's administrators;
   - the tenant-scoped `nearest` query that Phase 75 builds on.
3. **Identity:** `knowledge` in `SERVICE_GRANTS`, and its digest in compose.
4. **Wiring:**
   - `modules.json`, `Makefile`, compose (with an `ai` profile for TEI), Kong;
   - the Postgres init, the CI lists, `ci-local`, `demo.mjs`;
   - the restore drill, and the web proxy allowlist.
5. **Tests:**
   - units: extraction, chunking, embedders, sealing, the worker's states;
   - e2e on pgvector:
     - the plan touches one partition;
     - RLS;
     - erasure and tombstones;
     - quarantine;
     - a crash mid-document;
   - `scripts/phase74-smoke.mjs` through the stack: attach a file, see it indexed, delete
     it, see it gone.

## Exit evidence

- `EXPLAIN` of a nearest-neighbour query in tenant A touches only A's partition.
- Erasing a party removes its attachments' vectors, and a replayed
  `files.attachment.available` does not bring them back.
- A quarantined file is never indexed.
- Killing the worker mid-ingestion and restarting it leaves each chunk written once.
