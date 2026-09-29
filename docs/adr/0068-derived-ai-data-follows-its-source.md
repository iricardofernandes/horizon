# 68. Derived AI data follows its source's erasure and retention

- Status: accepted; planned for Phases 74–76 ([Phase N plan](../ai-implementation-plan.md)).
- Date: 2026-09-29

## Context

Erasure in Horizon is crypto-shredding: destroying a subject's key makes their plaintext
unrecoverable (ADR 0026). An index derived from their documents is a copy that the key does
not cover:
- chunk text is plaintext unless sealed again;
- embeddings can be partly inverted back into the text they came from.

## Decision

- **Embeddings are personal data** whenever their text is.
- **Chunk text** is sealed under `knowledge/`'s own key per owner (party or user). This is
  the pattern of Fiscal and CRM.
- **On `parties.party.erased`, `identity.data-subject.erased` or
  `files.attachment.deleted`:**
  - the vectors are **deleted**, since they are derived data and never a record;
  - the key is destroyed;
  - a tombstone refuses a late re-index.
- **Retention** follows the attachment's.
- **Assistant conversations** are sealed under the user's key, expire after 30 days, and
  are erased with the user.
- **Backups:** deleted vectors survive in backups until those expire (ADR 0063).
  `privacy.md` states that window with its real length.

## Consequences

- Erasure covers the index without breaking any audit chain, because nothing in the index
  is chained.
- The backup window is a stated limitation, not a hidden one.

## Alternatives considered

**Keep vectors and rely on the sealed text.** Rejected: embedding inversion recovers
meaningful text from vectors alone.

**Rebuild the whole index after each erasure.** Rejected: its cost grows with the tenant,
and deleting rows achieves the same thing.
