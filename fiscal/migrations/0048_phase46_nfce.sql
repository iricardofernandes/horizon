-- Phase 46: NFC-e model 65 as its own capability. A consumer sale is the same Sales
-- shipment origin as an NF-e, so one sale must never become documents of both models.

-- A model 65 document comes only from a Sales intent (no manual or linked origin).
ALTER TABLE fiscal_documents ADD CONSTRAINT fiscal_document_nfce_sales_origin
  CHECK (model <> '65' OR intent_id IS NOT NULL);

-- The first document of an intent fixes its model; a successor keeps it.
CREATE FUNCTION guard_fiscal_document_intent_model() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.intent_id IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text || ':intent-model:' ||
    NEW.intent_id::text, 0));
  IF EXISTS (
    SELECT 1 FROM fiscal_documents document
    WHERE document.tenant_id = NEW.tenant_id AND document.intent_id = NEW.intent_id
      AND document.model <> NEW.model
  ) THEN
    RAISE EXCEPTION 'A Sales intent keeps the model of its first fiscal document'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_documents_intent_model BEFORE INSERT ON fiscal_documents
  FOR EACH ROW EXECUTE FUNCTION guard_fiscal_document_intent_model();

-- Returns and complements reference an authorized NF-e model 55 only: a consumer's
-- return of an NFC-e is not supported yet.
CREATE OR REPLACE FUNCTION guard_fiscal_linked_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.referenced_document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM fiscal_documents document
    WHERE document.tenant_id = NEW.tenant_id AND document.id = NEW.referenced_document_id
      AND document.status = 'authorized' AND document.linked_origin_id IS NULL
      AND document.model = '55'
  ) THEN
    RAISE EXCEPTION 'A linked document must reference an authorized original'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
