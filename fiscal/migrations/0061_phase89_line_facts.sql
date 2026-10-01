-- Phase 89: the facts a line states come from the revisions readiness already binds. The
-- item's classification says whether the workspace is an IPI taxpayer for it; revisions
-- projected before this phase said nothing, and are read as false.
ALTER TABLE catalog_classifications ADD COLUMN ipi_taxpayer boolean NOT NULL DEFAULT false;
