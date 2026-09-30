-- Phase 79: the journal seal worker runs as the relay role and seals every tenant the module
-- knows, not only those with outbox rows, so a source with no events still settles in
-- Reporting. The relay reads only the id.
GRANT SELECT ("id") ON tenants TO horizon_relay;
--> statement-breakpoint
CREATE POLICY relay_known_tenants ON tenants FOR SELECT TO horizon_relay USING (true);
