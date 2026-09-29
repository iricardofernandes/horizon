# 68. Derived AI data follows its source's erasure and retention

- Status: accepted; the index side is implemented in Phase 74
  ([plan](../ai-phase74-implementation-plan.md)), with the revision below. Phase 75
  ([plan](../ai-phase75-implementation-plan.md)) extends it to full text: a chunk's words
  are stored only as HMAC hashes under a key derived for the tenant, never as a plaintext
  `tsvector`, and they go with the chunk. Phase 76 keeps conversations sealed under each
  person's own key in `agent/`, for 30 days, and erases them with the person. Phase 77's
  payable examples, derived from a supplier's name, go with `parties.party.erased` and
  with a reversal.
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

## Revision (Phase 74)

**A key per attachment, not per owner.** `files/` already ends every attachment of an erased
party or user with its own `files.attachment.deleted (erased)`. So the index learns every
erasure, retention expiry, removal and quarantine from that one event. Each document's chunk
text is sealed under a data key of the document, wrapped by `KNOWLEDGE_MASTER_KEY`. The
event:
- destroys that key;
- deletes the vectors;
- leaves the document row as the tombstone.

The index needs no owner mapping, and does not listen to the parties or identity erasure
events itself.
