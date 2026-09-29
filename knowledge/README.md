# `knowledge/`

The index of a workspace's documents: the text of its attachments, chunked, embedded and
sealed, in one pgvector partition per tenant, and gone with the file it came from.

An independently deployable NestJS service with its own database and container, reached
through Kong at `/knowledge`, sharing no source with any other module (ADR 0001).

**Status: Phase 75** (the index, and search with roles and citations). See the
[Phase 74 plan](../docs/ai-phase74-implementation-plan.md),
[Phase 75 plan](../docs/ai-phase75-implementation-plan.md),
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
- **Keyed lexemes** (Phase 75): each chunk's words, stemmed by PostgreSQL in Portuguese and
  English, are stored only as HMAC-SHA-256 hashes under a key derived for the tenant, with
  their positions, in `chunks.lexemes` (GIN-indexed). No word is stored in the clear, and
  the same word hashes differently in every tenant.

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

## Search

`GET /knowledge/search?q=…[&limit=…][&module=&recordType=&recordId=]` (Phase 75):

- **Who is searched:** the modules whose attachments the caller can read, by the same read
  roles as `files/`. A key's token is also narrowed to its scopes, and needs
  `knowledge:read`. A caller who reads none gets an empty answer.
- **How:** two candidate lists, each filtered by those modules **inside its scan**:
  - the question's vector against the tenant's HNSW index, with pgvector's iterative scan;
  - its keyed lexemes against the GIN index, ranked by `ts_rank_cd`.

  They are merged by reciprocal rank (k = 60). A chunk found only by its vector must be
  within the embedder's relevance distance. What the caller cannot read never takes a
  place in a ranking, so it answers exactly as what does not exist.
- **The answer:** `{ data: Citation[], searched: modules }`. Each citation has:
  - the attachment and its record;
  - the record's screen;
  - its position (chunk *n* of *m*);
  - the excerpt, opened with the document key;
  - how it was found (`meaning`, `words`).

  The question is never logged.

## Suggestions (Phase 77)

- **`GET /knowledge/suggestions/ncm?text=`** needs a Catalog role.
  **`GET /knowledge/suggestions/payable-category?text=&partyId=`** needs a Financial read
  role. **`POST /knowledge/suggestions/decisions`** counts an acceptance or a rejection,
  and keeps nothing.
- **The history** comes from events, into `examples PARTITION BY LIST (tenant_id)`, which
  has its own HNSW index per tenant:
  - every item (`catalog.item.created`), labelled with its NCM once it has one
    (`classification-changed`);
  - every posted payable, read through Kong as the service client: the supplier's name and
    the description, labelled with the category. A reversal or `parties.party.erased`
    removes it.

  Only the vector, the label, the source id and a short reference (name and SKU, or the
  document number) are kept.
- **The official NCM table** is `data/ncm-table.json.gz`, built by
  `scripts/build-ncm-table.mjs` from the Siscomex download. It is loaded into
  `ncm_codes` in the background, once per act and embedder, retrying until the model
  answers.
- **Ranking:**
  - examples within the embedder's example distance vote by similarity, the same supplier
    counting more;
  - official codes vote at half weight, and only when no example does.
- **Availability:** `KNOWLEDGE_SUGGESTIONS=auto` (the default) answers only with the `tei`
  embedder. Otherwise every route answers `available: false`, and the forms show nothing.

## Embedders

| `KNOWLEDGE_EMBEDDER` | Version | What it is |
|---|---|---|
| `hash` (default, CI) | `hash-384-v1` | Tokens and token pairs hashed into 384 signed buckets: lexical, deterministic, in process. Relevance distance 0.85 |
| `tei` (`make up-ai`) | `e5-small-v1` | `multilingual-e5-small` on Text Embeddings Inference, in the stack; nothing leaves it. Relevance distance 0.25 |

The index version is `<embedder>+lex-v1`. Switching the embedder, or the lexical scheme,
makes every document indexed by the other version due again.

E5 places unrelated passages about 0.2 apart, so with it a search always answers its
nearest passages, each cited. The hash embedder answers nothing to a question that shares
no word with the tenant's files.

**Retrieval evaluation.** `test/fixtures/retrieval-corpus.json` holds 24 documents in
Portuguese and English and 36 labelled questions (24 lexical, 12 semantic).
- `test/retrieval.e2e-spec.ts` runs it in CI with the hash embedder, and requires recall@5
  ≥ 0.9 on the lexical questions.
- `make eval-retrieval` runs it with e5 on TEI, requires recall@5 ≥ 0.8 overall, and
  stores the record in `docs/drills/`.

## Running and testing

The database needs the `vector` extension, which a superuser creates
(`infra/postgres/init`); the migration only checks that it is there.

```bash
npm install
npm test          # extraction, chunking, embedders, sealing, indexing, ranking, readers, search
npm run test:e2e  # pgvector: partitions, RLS, erasure, a lost lease, hybrid search, roles, canary, retrieval
node ../scripts/phase74-smoke.mjs   # the real stack, through files and Kong
node ../scripts/phase75-smoke.mjs   # search through Kong, a narrowed key, the agent, a canary
make -C .. eval-retrieval           # recall@5 with e5, recorded
node ../scripts/phase77-smoke.mjs --expect-off   # without the ai profile: no suggestion
node ../scripts/phase77-smoke.mjs   # with make up-ai: history, table, canary, category, audit
```

Metrics: `knowledge_index_lag_seconds`, `knowledge_documents_settled{state}`,
`knowledge_embedding_seconds`, `knowledge_search_seconds{outcome}`,
`knowledge_suggestion_seconds{kind,outcome}` and
`knowledge_suggestion_decisions_total{kind,decision}`, with no tenant label.
