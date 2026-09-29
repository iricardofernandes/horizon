# Phase 75 evidence — Search by meaning, with roles and citations

[Plan](ai-phase75-implementation-plan.md) ·
[Phase N plan](ai-implementation-plan.md#75--search-by-meaning-with-roles-and-citations) ·
smoke records: [hash embedder](drills/2026-09-29-phase75-search-smoke.json),
[multilingual-e5-small](drills/2026-09-29-phase75-search-smoke-e5.json) ·
retrieval records: [hash](drills/2026-09-29-phase75-retrieval-hash.json),
[e5](drills/2026-09-29-phase75-retrieval-tei.json) ·
[module README](../knowledge/README.md)

## What was delivered

- **`GET /knowledge/search`,** behind Kong. It takes the question (2 to 200 characters),
  optionally a limit (at most 50), and optionally one record whose attachments alone are
  searched.
  - **The caller's roles decide.** The searched modules are those whose attachments the
    caller reads, by `files/`'s own read roles, copied with a test that reads `files/`'s
    source and compares. A key's token is also narrowed to its scopes, and needs
    `knowledge:read`.
  - **Two candidate lists,** each filtered by those modules inside its own scan:
    - the vector against the tenant's HNSW index, with `hnsw.iterative_scan =
      relaxed_order`;
    - keyed lexemes against a GIN index, ranked by `ts_rank_cd`.

    Merged by reciprocal rank (k = 60), with a relevance distance per embedder for chunks
    found only by their vector.
  - **Every result is a citation:** the attachment, the record, the record's screen,
    chunk *n* of *m*, the excerpt opened with the document key, and whether it matched
    by meaning, by words, or both.
- **Keyed lexemes.** Migration `0001_search` adds `chunks.lexemes tsvector`, with a GIN
  index on the partitioned parent, so present and future partitions have it.
  - PostgreSQL stems each chunk (Portuguese and English, accents folded), keeping only the
    words that neither language holds a stop word.
  - `knowledge/` stores each lexeme only as an HMAC-SHA-256 under a key derived from the
    master key for the tenant.
  - The index version became `<embedder>+lex-v1`, so every document indexed in Phase 74
    re-indexed in the background. The stack's documents did.
- **The agent:** `search_documents` (module `knowledge`, `knowledge:read`), 10 results
  unless the agent asks for up to 20.
- **Web:**
  - the Ctrl+K palette has a Documents group: the excerpt, the record type, "excerpt *n*
    of *m*", and a link to the record's screen. It is asked only when the person reads
    some attaching module;
  - each attachments panel has "Search this record's attachments", naming each result's
    file from the panel's own list;
  - pt-BR and en.
- **Evaluation:**
  - `test/fixtures/retrieval-corpus.json`: 24 documents in Portuguese and English across
    the five attaching modules, and 36 questions (24 lexical, 12 semantic);
  - `test/retrieval.e2e-spec.ts`, which runs in CI with the hash embedder;
  - `make eval-retrieval`, which runs it with e5 on TEI (now published on
    `127.0.0.1:8088` in the `ai` profile) and stores the record.
- **Metrics:** `knowledge_search_seconds{outcome}`.

## Exit evidence

| Criterion | Proof |
|---|---|
| A canary document in tenant B never appears in tenant A, whatever the query | e2e: B's canary is absent from A's answers to its full text, its marker and two paraphrases, and first in B's own. Smoke: the same through Kong, in two new workspaces, with both embedders |
| A user without a Financial role never gets a chunk of a payable's attachment, and the search does not tell them one exists | e2e: a parties and CRM reader's answer to the invoice's words is equal to its answer to nonsense (`{data: [], searched: [parties, crm]}`), and a Financial reader finds it. Among 200 Financial chunks, a parties reader gets exactly the one party chunk. Smoke: a key with `parties:read` and `knowledge:read` gets for the invoice's words exactly what it gets for nonsense, and never the invoice; so does the agent's `search_documents` with the same scopes |
| Recall@5 meets the gate the detailed plan sets, and its record is stored | Hash (CI gate: lexical ≥ 0.9): lexical **1.000**, semantic 0.000, all 0.667. e5 (gate: all ≥ 0.8): lexical **1.000**, semantic **0.667**, all **0.889**, MRR 0.766. Both records are in `docs/drills/` |

### Also proven

- **No word in the clear.** The stored `lexemes` of a chunk are 32-hex hashes with
  positions, and contain none of its words (e2e). Units show the same word hashing
  differently per tenant and per master key.
- **Stemming and folding:** "contratos manutencao" finds "Contrato de manutenção" by words
  (e2e); "contratos de fornecimento de cafe" finds the contract through Kong (smoke).
- **The record filter** answers one record's attachments only, and none when the caller
  cannot read that record's module (e2e and unit).
- **The relevance cut:** with the hash embedder, a question that shares nothing with the
  tenant's files answers nothing (e2e).
- **Erasure:** erasing the party takes its contract out of search (smoke).
- **The key guard:** a key without `knowledge:read` is refused (smoke).

## What changed from the plan

- **Bilingual stop words.** The first e5 evaluation gave semantic recall 0.5 against 0.667
  for the vector alone. The cause was the union of both stemmers: "de" survived the English
  one and matched every Portuguese chunk. A word is now kept only where both languages
  find it meaningful. With that, the hybrid equals the vector alone on semantic questions,
  and keeps lexical recall at 1.0.
- **E5 always answers.** No absolute distance separates e5's paraphrases (0.13 to 0.24)
  from unrelated passages (median about 0.2). With e5 a search returns its nearest
  passages, each cited, and the smoke's check compares the hidden answer with the
  nonsense answer rather than expecting both empty.
- **The search is a `GET`,** as decided in the plan, revising the Phase N plan's `POST`.

## Verification

- `knowledge/`:
  - 47 unit tests (domain and application: 99% of lines, 92% of branches);
  - 18 e2e tests on pgvector 0.8.1: Phase 74's nine, eight on search, and the retrieval
    gate.
- `agent/`: 39 unit tests, with `search_documents` in the catalogue tests.
- `web/`: 139 unit tests (3 new in `lib/documents.spec.ts`); typecheck and lint clean.
- **Smoke** `scripts/phase75-smoke.mjs`: 9 of 9 checks, with the hash embedder and with
  e5.
- **`make eval-retrieval`:** passed, and recorded.
- The phase's closing runs (`ci-local --full`, `make demo` twice, `make test-phase10`,
  `deck`, `make test-alerts`) are listed in the commit's report.
- **In a browser** (a new workspace, signed in through the web, English):
  - Ctrl+K with "fornecimento de café" lists a Document option: the contract's excerpt,
    "Party · excerpt 1 of 1";
  - Enter opens the parties screen;
  - the party's attachments panel, searched for "entregas em Campinas", shows
    `contrato-navegador.txt`, "excerpt 1 of 1" and the excerpt.
