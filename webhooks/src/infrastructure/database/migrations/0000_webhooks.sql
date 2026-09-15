CREATE TABLE tenants (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_subscriptions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  endpoint_url text NOT NULL,
  event_types text[] NOT NULL CHECK (cardinality(event_types) > 0),
  secret_ciphertext text NOT NULL,
  active integer NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT webhook_subscriptions_tenant_id_key UNIQUE (tenant_id, id)
);

CREATE TABLE webhook_events (
  event_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  event_type text NOT NULL,
  event_version smallint NOT NULL CHECK (event_version > 0),
  occurred_at timestamptz NOT NULL,
  trace_id text NOT NULL,
  envelope jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhook_events_tenant_event_key UNIQUE (tenant_id, event_id)
);

CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  subscription_id uuid NOT NULL,
  event_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'delivering', 'succeeded', 'dead-letter')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL,
  locked_until timestamptz,
  last_response_status integer,
  last_error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT webhook_deliveries_subscription_fk FOREIGN KEY (tenant_id, subscription_id)
    REFERENCES webhook_subscriptions(tenant_id, id),
  CONSTRAINT webhook_deliveries_event_fk FOREIGN KEY (tenant_id, event_id)
    REFERENCES webhook_events(tenant_id, event_id),
  CONSTRAINT webhook_deliveries_subscription_event_key UNIQUE (subscription_id, event_id),
  CONSTRAINT webhook_deliveries_tenant_id_key UNIQUE (tenant_id, id)
);

CREATE TABLE webhook_delivery_attempts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  delivery_id uuid NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  attempted_at timestamptz NOT NULL,
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  response_status integer,
  error text,
  CONSTRAINT webhook_delivery_attempts_delivery_fk FOREIGN KEY (tenant_id, delivery_id)
    REFERENCES webhook_deliveries(tenant_id, id)
);

CREATE TABLE inbox (
  source_module text NOT NULL,
  event_id uuid NOT NULL,
  event_type text NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inbox_source_event_key UNIQUE (source_module, event_id)
);

CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at, id)
  WHERE status IN ('pending', 'delivering');
CREATE INDEX webhook_deliveries_tenant_status_idx
  ON webhook_deliveries (tenant_id, status, created_at DESC);
CREATE INDEX webhook_attempts_delivery_idx
  ON webhook_delivery_attempts (tenant_id, delivery_id, attempted_at);

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO horizon_app, horizon_relay;

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'webhook_subscriptions', 'webhook_events', 'webhook_deliveries',
    'webhook_delivery_attempts', 'inbox'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_scope ON %I TO horizon_app USING (tenant_id = current_setting(''app.current_tenant'')::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant'')::uuid)',
      table_name
    );
  END LOOP;
END $$;
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON tenants TO horizon_app
  USING (id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (id = current_setting('app.current_tenant')::uuid);

REVOKE ALL ON tenants, webhook_subscriptions, webhook_events, webhook_deliveries,
  webhook_delivery_attempts, inbox FROM horizon_app, horizon_relay;
GRANT SELECT, INSERT ON tenants, webhook_events, inbox TO horizon_app;
GRANT SELECT, INSERT, UPDATE ON webhook_subscriptions, webhook_deliveries TO horizon_app;
GRANT SELECT ON webhook_delivery_attempts TO horizon_app;
GRANT SELECT, INSERT, UPDATE ON webhook_subscriptions, webhook_events, webhook_deliveries,
  webhook_delivery_attempts TO horizon_relay;

CREATE POLICY relay_subscriptions ON webhook_subscriptions TO horizon_relay USING (true);
CREATE POLICY relay_events ON webhook_events TO horizon_relay USING (true);
CREATE POLICY relay_deliveries ON webhook_deliveries TO horizon_relay USING (true) WITH CHECK (true);
CREATE POLICY relay_attempts ON webhook_delivery_attempts TO horizon_relay USING (true) WITH CHECK (true);

CREATE FUNCTION reject_webhook_attempt_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'webhook delivery attempts are append-only'; END $$;
CREATE TRIGGER webhook_attempts_append_only BEFORE UPDATE OR DELETE OR TRUNCATE
  ON webhook_delivery_attempts FOR EACH STATEMENT EXECUTE FUNCTION reject_webhook_attempt_mutation();
