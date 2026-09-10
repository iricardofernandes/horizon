-- Roles are provisioned outside migrations by the cluster administrator.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO horizon_app, horizon_relay;
--> statement-breakpoint
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['users', 'api_keys', 'data_subject_keys', 'audit_log', 'outbox', 'inbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO horizon_app USING (tenant_id = current_setting(''app.current_tenant'')::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)', table_name);
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON tenants TO horizon_app
  USING (id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (id = current_setting('app.current_tenant')::uuid);
--> statement-breakpoint
ALTER TABLE tenant_directory ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_directory FORCE ROW LEVEL SECURITY;
CREATE POLICY directory_read ON tenant_directory FOR SELECT TO horizon_app USING (true);
CREATE POLICY directory_register ON tenant_directory FOR INSERT TO horizon_app
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
--> statement-breakpoint
REVOKE ALL ON tenants, users, api_keys, data_subject_keys, audit_log, outbox, inbox, tenant_directory FROM horizon_app, horizon_relay;
GRANT SELECT, INSERT, UPDATE ON tenants, users, api_keys, data_subject_keys TO horizon_app;
GRANT SELECT, INSERT ON audit_log, outbox, inbox, tenant_directory TO horizon_app;
GRANT SELECT, UPDATE ON outbox TO horizon_relay;
CREATE POLICY relay_delivery ON outbox TO horizon_relay USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
--> statement-breakpoint
CREATE FUNCTION stamp_outbox_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> current_setting('app.current_tenant')::uuid THEN
    RAISE EXCEPTION 'outbox tenant does not match transaction';
  END IF;
  NEW.tenant_id := current_setting('app.current_tenant')::uuid;
  RETURN NEW;
END $$;
CREATE TRIGGER outbox_tenant_stamp BEFORE INSERT ON outbox
  FOR EACH ROW EXECUTE FUNCTION stamp_outbox_tenant();
