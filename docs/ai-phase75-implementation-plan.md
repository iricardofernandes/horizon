# Phase 75 — Search by meaning, with roles and citations

Status: **delivered on 2026-09-29** ([evidence](ai-phase75-evidence.md)). This is the execution record for
[Phase 75 of the AI with isolation plan](ai-implementation-plan.md#75--search-by-meaning-with-roles-and-citations),
built on ADR 0067 (one partition per tenant, roles inside the scan), ADR 0068 (derived
data follows its source) and ADR 0069 (models are ports).

## Result

After this phase:
- **`GET /knowledge/search?q=`** answers a hybrid search in the caller's tenant:
  - the question's vector against the tenant's HNSW index;
  - its words against a full-text index of the same chunks, stemmed in Portuguese and
    English;
  - both lists merged by reciprocal rank.
- **Roles decide inside the scan.** Both lists are filtered in SQL by the modules whose
  attachments the caller can read, with pgvector's iterative scan. A chunk the caller
  cannot read never takes a place in a ranking. The answer is the same whether or not it
  exists.
- **Every result is a citation:** the attachment, the record it belongs to, its position
  in the file (chunk *n* of *m*), the excerpt, and the path of the record's screen. There
  is no result without a source.
- **The agent** has `search_documents`, with `knowledge:read`. It sees only the modules its
  key reaches, because the key's token carries roles only there.
- **Web:**
  - a "Documents" group in the Ctrl+K palette;
  - "Search this record's attachments" in the attachments panel.
- **Retrieval evaluation:**
  - a fixed bilingual corpus with labelled questions runs in CI with the deterministic
    embedder, as a lexical gate;
  - `make eval-retrieval` runs it with `multilingual-e5-small` and stores recall@5 in
    `docs/drills/`.

## Starting point

- **Phase 74** indexes available attachments. Each chunk is:
  - sealed under its document's key;
  - embedded, in its tenant's partition with its own HNSW index;
  - labelled with its module, record type and record.

  `nearest` already names the tenant so the planner prunes.
- **Access to attachments:** `files/` grants reading an attachment by the owning module's
  read roles (`permits`). A key token carries its issuer's roles only in the modules it has
  a scope for (Phase 71).
- **The knowledge guard** refuses a key without `knowledge:read` on a `GET`.
- **The web's federated search (Phase 66)** already sends its terms as a `GET` query, with
  the person's token.

## Decisions frozen by this plan

1. **Full text over keyed lexemes, not a plaintext `tsvector`.**
   - A `tsvector` of a chunk is its words in the clear. It would undo the sealing of
     ADR 0068.
   - So PostgreSQL stems the text transiently (`to_tsvector('portuguese')` and
     `('english')`, after folding accents), and `knowledge/` replaces each lexeme by an
     HMAC-SHA-256 under a key derived from the master key **per tenant**.
   - Only those hashes, with their positions, are stored in `chunks.lexemes`, which has a
     GIN index on the partitioned parent.
   - A word is kept only where **neither** language holds it a stop word: both parsers
     number words alike, so a position both stemmers kept is a word both find meaningful.
     Without this, "de" survives the English stemmer and "the" the Portuguese one, and
     every chunk matches every question. The first evaluation run showed it; this is a
     revision made during the phase.
   - A question is stemmed and hashed the same way, and matched with `@@` and ranked with
     `ts_rank_cd`.
   - The hashes differ between tenants, and go with the chunk on erasure, like the vector.
   - The index version becomes `<embedder>+lex-v1`, so every document indexed in Phase 74
     re-indexes in the background.
2. **The search is a `GET`,** as every other search in the platform and every read tool in
   the agent's catalogue:
   - the key guard reads it as a read (`knowledge:read`);
   - the term is bounded to 200 characters, and it is never logged by `knowledge/`.

   This revises the Phase N plan's `POST`.
3. **Readable modules:**
   - the owning modules' read roles, copied from `files/` (`permits`), with a test that the
     tables are equal;
   - intersected with the key's scopes when the token has any;
   - no readable module answers an empty list, not a refusal.
4. **Ranking:**
   - each list takes 40 candidates:
     - the vector list with `hnsw.iterative_scan = relaxed_order`, re-sorted by distance;
     - the text list by `ts_rank_cd`.
   - Reciprocal rank fusion with k = 60.
   - A candidate found only by its vector must be within the embedder's relevance
     distance:
     - 0.85 for the hash embedder (a shared word or pair). With it, a question that shares
       no word with the tenant's files answers nothing.
     - 0.25 for e5. Its unrelated passages sit about 0.2 apart, and the semantic matches
       of the corpus between 0.13 and 0.24, so no cut separates them. With e5 a search
       always answers its nearest passages, each cited; the cut only drops the far tail.
   - At most 10 results by default and 50 at most, with one per chunk.
5. **Citations:** `{ attachmentId, record: { module, recordType, recordId }, screen,
   position: { chunk, of }, excerpt, matchedBy }`.
   - The excerpt is the chunk's text, opened with the document key.
   - The screen path comes from `knowledge/`'s own map of attachable record types.
   - The index never learns file names: the attachments panel shows its own.
6. **Evaluation:**
   - `test/fixtures/retrieval-corpus.json`: 24 short documents in Portuguese and English
     across the five modules, and 36 questions, each naming its expected document.
     - `lexical`: the question shares its key words with the document.
     - `semantic`: a paraphrase, or the other language.
   - **Gates:**
     - the hash embedder must reach recall@5 ≥ 0.9 on the lexical questions (CI);
     - e5 must reach recall@5 ≥ 0.8 on all of them (`make eval-retrieval`, recorded).
   - The record stores the numbers and never the questions' answers.
7. **Metrics:** `knowledge_search_seconds`, with an `outcome` label (`ok`, `empty`), and no
   tenant label.

## Work

1. **`knowledge/`:**
   - migration `0001_search`: `lexemes tsvector` and its GIN index;
   - the lexeme hasher;
   - lexemes at indexing time;
   - the composite index version;
   - `Search` (readable modules, fusion, citations) and its controller;
   - the metric.
2. **Agent:** `search_documents` in the catalogue (module `knowledge`), with its tests.
3. **Web:**
   - `lib/documents.ts` (which modules make a person able to search, and the palette's
     options);
   - the palette's Documents group;
   - the attachments panel's search;
   - pt-BR and en.
4. **Evaluation:**
   - the corpus;
   - `test/retrieval.e2e-spec.ts`, whose gate runs in CI;
   - `make eval-retrieval`, with TEI published on `127.0.0.1:8088` in the `ai` profile.
5. **Tests:**
   - units: fusion, readable modules, the table-equality test with `files/`, the hasher,
     the search use case;
   - e2e on pgvector:
     - hybrid ranking;
     - roles inside the scan: 200 financial chunks do not starve the one party chunk of a
       parties-only reader;
     - no difference between hidden and absent;
     - the canary across tenants;
     - the record filter;
     - the relevance cut.
6. **`scripts/phase75-smoke.mjs`** through Kong:
   - the owner finds and cites a party's contract and a payable's invoice;
   - a key with only `parties:read` and `knowledge:read` finds the contract and not the
     invoice, and its search for the invoice's words answers exactly what a search for
     nonsense answers;
   - the agent's `search_documents` with the same scopes;
   - a canary in a second workspace never appears in the first;
   - after the party is erased, the contract is gone from search.

## Exit evidence

- A canary document in tenant B never appears in tenant A, whatever the query.
- A user without a Financial role never gets a chunk of a payable's attachment, and the
  search does not tell them one exists.
- Recall@5 on the corpus meets the gates above, and its record is stored.
