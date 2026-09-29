-- Full text over keyed lexemes (Phase 75, ADR 0068): PostgreSQL stems a chunk transiently,
-- and only an HMAC of each lexeme under a key of the tenant is stored, with its positions.
-- The text itself stays sealed; the hashes go with the chunk, like its vector.
ALTER TABLE "chunks" ADD COLUMN "lexemes" tsvector DEFAULT ''::tsvector NOT NULL;
--> statement-breakpoint
-- On the partitioned parent: every partition, present and future, gets its own GIN index.
CREATE INDEX "chunks_lexemes_idx" ON "chunks" USING gin ("lexemes");
