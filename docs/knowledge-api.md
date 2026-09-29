# Knowledge API reference

The index of a workspace's attachments, search with citations, and suggestions
([ADR 0067](adr/0067-documents-are-indexed-in-one-partition-per-tenant.md),
[ADR 0068](adr/0068-derived-ai-data-follows-its-source.md),
[ADR 0069](adr/0069-models-are-ports-and-generation-is-opt-in.md); Phases 74, 75 and 77).
- **Path:** through Kong, every path below is prefixed with `/knowledge`.
- **Tokens:** a person's token, or a key's token with `knowledge:read`. A key reaches only
  the modules its scopes name.
- **Roles:** `knowledge` has none. The owning modules' read roles decide, exactly as
  `files/` decides who reads an attachment.

## Routes

| Route | Needs | Does |
|---|---|---|
| `GET /status` | Identity owner, admin or auditor | the workspace's documents by state, its chunk count and the index version (`<embedder>+lex-v1`) |
| `GET /search?q=&limit=&module=&recordType=&recordId=` | any token | a hybrid search, as below |
| `GET /suggestions/ncm?text=` | a Catalog role | NCM suggestions for an item's name |
| `GET /suggestions/payable-category?text=&partyId=` | a Financial read role | category suggestions for a payable |
| `POST /suggestions/decisions` | the kind's role | `{ kind, decision: accepted \| rejected, rank? }` → `204`, counted as a metric only |

## Search

- **`q`:** 2 to 200 characters. `limit` is 1 to 50, 10 by default. `module`, `recordType`
  and `recordId` go together, and search one record's attachments.
- **Who is searched:** the modules whose attachments the caller reads. They filter both
  candidate lists inside their scans:
  - the vector list, on the tenant's own HNSW index, with an iterative scan;
  - the keyed full-text list, on a GIN index.

  They are merged by reciprocal rank (k = 60). A caller who reads none gets an empty
  answer, not a refusal.
- **The answer:** `{ data, searched }`. Each citation has:
  - `attachmentId`;
  - `record: { module, recordType, recordId }`;
  - `screen`, the web path of the record;
  - `position: { chunk, of }`;
  - `excerpt`;
  - `score`;
  - `matchedBy`: `meaning`, `words`, or both.

  What the caller cannot read answers exactly as what does not exist.
- **Privacy:** the question is never logged, and no answer carries a vector or a keyed
  hash.

## Suggestions

- **The answer:** `{ available, suggestions }`, where each suggestion is
  `{ value, score, description, reason: { examples, officialTable } }`:
  - `examples` are the workspace's own records that voted, up to three: `sourceId`,
    `reference` (an item's name and SKU, or a payable's document number), `similarity`,
    `sameParty`;
  - `officialTable` says the official NCM table voted. It votes only when no example
    does.
- **Off:** `available: false` whenever suggestions are off. That is the default without
  the local model (`KNOWLEDGE_SUGGESTIONS=auto`).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `KNOWLEDGE_EMBEDDER` | `hash` | `hash` (deterministic) or `tei` (`multilingual-e5-small`, `make up-ai`) |
| `TEI_URL` | `http://localhost:8088` | Text Embeddings Inference |
| `KNOWLEDGE_SUGGESTIONS` | `auto` | `auto` (on with `tei` only), `on` or `off` |
| `KNOWLEDGE_NCM_TABLE` | `data/ncm-table.json.gz` | the official table, built by `scripts/build-ncm-table.mjs` |
| `KNOWLEDGE_MASTER_KEY` | — | wraps every document key (32 bytes) |
| `GATEWAY_URL`, `SERVICE_TOKEN_SECRET` | — | how the `knowledge` service client reads files and payables |

## Events consumed

| Event | Effect |
|---|---|
| `files.attachment.available` | due for indexing, unless its tombstone says the file ended |
| `files.attachment.deleted`, `files.attachment.quarantined` | chunks deleted, key destroyed, tombstone kept |
| `catalog.item.created`, `catalog.item.classification-changed` | an item example, labelled with its NCM once it has one |
| `financial.payable.posted`, `financial.payable.reversed` | a payable example is added or removed |
| `parties.party.erased` | the party's payable examples are removed |

## Metrics

None has a tenant label:
- `knowledge_index_lag_seconds`;
- `knowledge_documents_settled_total{state}`;
- `knowledge_embedding_seconds`;
- `knowledge_search_seconds{outcome}`;
- `knowledge_suggestion_seconds{kind,outcome}`;
- `knowledge_suggestion_decisions_total{kind,decision}`.

The service levels are in [service-levels.md](service-levels.md#phase-n--the-agent-the-index-search-and-suggestions).
