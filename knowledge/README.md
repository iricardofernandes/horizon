# `knowledge/`

The index of a workspace's documents: the text of its attachments, chunked, embedded and
sealed, in one pgvector partition per tenant, and gone with the file it came from.

An independently deployable NestJS service with its own database and container, reached
through Kong at `/knowledge`, sharing no source with any other module (ADR 0001).

**Status: Phase 74** (the index). Search arrives in Phase 75. See the
[Phase 74 plan](../docs/ai-phase74-implementation-plan.md),
[ADR 0067](../docs/adr/0067-documents-are-indexed-in-one-partition-per-tenant.md),
[ADR 0068](../docs/adr/0068-derived-ai-data-follows-its-source.md) and
[ADR 0069](../docs/adr/0069-models-are-ports-and-generation-is-opt-in.md).

---

## What this context owns

- **Documents,** one row per attachment, holding:
  - its state: `pending → indexing → indexed | no-text | failed`, or `deleted`, which is
    its tombstone;
  - the content digest, the index version, the chunk count and the wrapped key.
- **Chunks,** `PARTITION BY LIST (tenant_id)`:
  - each tenant has its own partition, created on first use by `ensure_chunk_partition`
    (security definer, migration role), with its own HNSW index (`vector_cosine_ops`) and
    forced RLS;
  - the application reaches them only through the parent table, and a search names its
    tenant, so the planner prunes to that one partition.
- **The document keys:** each document's chunk text is sealed with AES-256-GCM under a key
  of its own, wrapped by `KNOWLEDGE_MASTER_KEY` and bound to the tenant, the attachment and
  the chunk's position.

## How a file gets in, and out

1. **Available.** `files.attachment.available` records the document `pending`, in the
   transaction that claims the inbox, unless its tombstone says the file ended.
2. **Worker.** It finds tenants with due work as the relay role (`tenant_id`, `due_at`,
   `state` and `index_version` only) and claims documents with a lease. Then, for each
   document:
   - it reads the file through Kong as the `knowledge` service client: a viewer of
     `parties`, `procurement`, `financial`, `sales` and `crm`, the modules with
     attachments;
   - it extracts the text: plain text, CSV, PDF text layers, DOCX, XLSX (no OCR; an image
     is `no-text`);
   - it chunks the text (800 characters, 100 overlap, at most 400 chunks), embeds it and
     seals it;
   - it writes every chunk in one transaction, which is refused if the lease was lost.

   A failure retries with backoff, and the fifth one leaves the document `failed`.
3. **Ended.** `files.attachment.deleted` (removed, expired, erased with its owner,
   abandoned) and `files.attachment.quarantined` delete the chunks, destroy the key and
   leave the tombstone.

## Embedders

| `KNOWLEDGE_EMBEDDER` | Version | What it is |
|---|---|---|
| `hash` (default, CI) | `hash-384-v1` | Tokens and token pairs hashed into 384 signed buckets: lexical, deterministic, in process |
| `tei` (`make up-ai`) | `e5-small-v1` | `multilingual-e5-small` on Text Embeddings Inference, in the stack; nothing leaves it |

Switching the embedder makes every document indexed by the other version due again.

## Running and testing

The database needs the `vector` extension, which a superuser creates
(`infra/postgres/init`); the migration only checks that it is there.

```bash
npm install
npm test          # extraction, chunking, embedders, sealing, the indexing states
npm run test:e2e  # pgvector: one partition per plan, RLS, erasure, tombstones, a lost lease
node ../scripts/phase74-smoke.mjs   # the real stack, through files and Kong
```

Metrics: `knowledge_index_lag_seconds`, `knowledge_documents_settled{state}` and
`knowledge_embedding_seconds`, with no tenant label.
