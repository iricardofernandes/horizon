# Phase 74 evidence — The document index, one partition per tenant

[Plan](ai-phase74-implementation-plan.md) ·
[Phase N plan](ai-implementation-plan.md#74--the-document-index-one-partition-per-tenant) ·
smoke records: [hash embedder](drills/2026-09-29-phase74-index-smoke.json),
[multilingual-e5-small](drills/2026-09-29-phase74-index-smoke-e5.json) ·
[module README](../knowledge/README.md)

## What was delivered

- **PostgreSQL:** `infra/postgres/image` builds `postgres:17-alpine` (pinned by digest) plus
  pgvector 0.8.1, compiled without LLVM.
  - Compose, the backup job and the restore drill run it.
  - The local cluster moved to it on its existing volume. It is still PostgreSQL 17.11 on
    musl, and still `en_US.utf8`.
- **`knowledge/`,** port 3016, database `horizon_knowledge`, behind Kong at `/knowledge`.
  The wiring checklist:
  - `modules.json`, `Makefile`, compose with its migration job and an `ai` profile for TEI,
    `kong.yml`;
  - the Postgres init, which also creates the `vector` extension;
  - the isolation, release and golden-path workflows, `ci-local`, `demo.mjs`, the restore
    drill;
  - the web proxy allowlist.
- **The schema:**
  - `documents` (state, digest, index version, wrapped key, lease, attempts);
  - `chunks PARTITION BY LIST (tenant_id)`;
  - `ensure_chunk_partition` (security definer, only for the tenant of the transaction,
    advisory-locked). It creates a tenant's partition with its HNSW index and forced RLS,
    and revokes direct access;
  - forced RLS everywhere, and the relay role limited to `tenant_id`, `due_at`, `state`
    and `index_version`.
- **Indexing:**
  - the consumer records `pending` with the inbox claim;
  - the worker claims due documents with a lease, then reads the file through Kong as the
    `knowledge` service client;
  - it extracts the text (plain text, CSV, PDF with `pdf-parse`, DOCX and XLSX with
    `fflate`), chunks it, embeds it, and seals each chunk under the document's own key;
  - it writes every chunk in one transaction, refused if the lease was lost;
  - it retries with backoff, and records an error only by its class.
- **Identity:** the `knowledge` service client, a viewer of `parties`, `procurement`,
  `financial`, `sales` and `crm`, and nothing more.
- **Embedders:**
  - `hash-384-v1`, deterministic, the default and CI's;
  - `e5-small-v1` (`multilingual-e5-small` on TEI, `make up-ai`).

  Documents indexed by another version become due again.

## Exit evidence

| Criterion | Proof |
|---|---|
| `EXPLAIN` of a search in tenant A touches only A's partition | e2e: the plan names `chunks_<A>` and not `chunks_<B>`, with both indexed. Smoke: the plan of a search in the new workspace names its partition alone |
| Erasing a party removes its attachments' vectors, and a replayed `available` does not bring them back | Smoke: erasing the party leaves the contract `deleted/erased`, with 0 chunks, no key and none in the partition. e2e: after an erasure, a new `available` event answers `tombstoned` and the worker writes nothing |
| A quarantined file is never indexed | Smoke: the EICAR file ends `deleted/quarantined` with 0 chunks. e2e: `quarantined`, then `available`, is tombstoned and never indexed |
| Killing the worker mid-ingestion leaves each chunk written once | e2e: a claim is taken and abandoned; past its lease another worker writes the document; the first worker's late completion is refused; every ordinal is present once, with `attempts = 2` |

### Also proven

- **Sealed text.** The raw `sealed_text` does not contain the text, and the document key
  opens it (e2e). In the smoke, no row of the partition contains the file's marker.
- **Access to the partitions.**
  - Each partition has its own HNSW index (`vector_cosine_ops`).
  - The application role is refused direct access to a partition, even inside its own
    tenant's transaction.
  - A tenant sees only its own chunks through the parent.
- **Settled states:** an image ends `no-text`, and a redelivered event does nothing twice.
- **A model change** re-indexes an old version's document in the background (e2e).
- **The same smoke passes with `multilingual-e5-small`** on the local TEI: 7 of 7, index
  version `e5-small-v1`. No tenant text left the stack to be embedded.
- **Tests:**
  - `knowledge/`: 27 units (100% lines of domain and application) and 9 e2e on
    `pgvector/pgvector:0.8.1-pg17`;
  - Identity: the `knowledge` grants.

## Found along the way

- **The planner errs on RLS before the permission check.** A direct query on a partition
  without `app.current_tenant` fails on the policy's `current_setting` while being planned,
  before the permission check. With the tenant set, as the application always runs, the
  partition answers `permission denied`. The test asserts the latter.
- **`vector` is not a trusted extension.** The migration role cannot create it, so the init
  script does. On an existing local cluster, create it by hand with the database, as the
  README says.
- **Erasing a party ends every one of its files,** the image included, so the index learns
  each one from `files/`. The smoke's first expectation was wrong, not the index.
