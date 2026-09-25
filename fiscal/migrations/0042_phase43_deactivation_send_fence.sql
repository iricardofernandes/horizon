-- The normal worker checks activation before selecting work. Serialize the
-- irreversible send marker with deactivation as a final database fence.
CREATE FUNCTION fence_fiscal_homologation_deactivated_send()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE selected_service text;
DECLARE definition fiscal_capability_definitions%ROWTYPE;
DECLARE latest_action text;
BEGIN
  SELECT capability.* INTO definition
  FROM fiscal_homologation_exchanges exchange
  JOIN fiscal_homologation_drill_grants grant_row
    ON grant_row.tenant_id = exchange.tenant_id AND grant_row.id = exchange.drill_grant_id
  JOIN fiscal_capability_definitions capability
    ON capability.tenant_id = grant_row.tenant_id AND capability.id = grant_row.capability_id
  WHERE exchange.tenant_id = NEW.tenant_id AND exchange.id = NEW.exchange_id;
  SELECT exchange.service INTO selected_service FROM fiscal_homologation_exchanges exchange
  WHERE exchange.tenant_id = NEW.tenant_id AND exchange.id = NEW.exchange_id;
  IF selected_service IN ('receipt', 'protocol') THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW.tenant_id::text || ':' || definition.model || ':' || definition.environment || ':' ||
    definition.establishment_id::text || ':' || definition.jurisdiction_kind || ':' ||
    definition.jurisdiction_code || ':' || definition.operation, 0
  ));
  SELECT event.action INTO latest_action FROM fiscal_capability_activation_events event
  WHERE event.tenant_id = NEW.tenant_id AND event.capability_id = definition.id
  ORDER BY event.created_at DESC, event.id DESC LIMIT 1;
  IF latest_action = 'deactivate' THEN
    RAISE EXCEPTION 'Homologation capability was deactivated before transmission'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_homologation_deactivated_send_fence
  BEFORE INSERT ON fiscal_homologation_transmissions
  FOR EACH ROW EXECUTE FUNCTION fence_fiscal_homologation_deactivated_send();
