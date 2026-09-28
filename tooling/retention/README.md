# `tooling/retention/`

The retention job of ADR 0063 (Phase 69). It removes delivery bookkeeping — every module's
`inbox` after 90 days, and `command_receipts` after 30 — as each module's relay role,
which may see only a row's tenant and age. Posted records, audit logs, outboxes and the
reporting journal are never removed, and the policy refuses to name them.

It also reports what other workers own: exports and attachments still present an hour
past their expiry, and Redis keys under Identity's prefixes that have no TTL.

Every run writes one JSON line per class, table and tenant with the count removed, and a
`retention.run` summary. Loki collects them from the container's output.

- `policy.json`: the rules and what is reported.
- `RETENTION_DATABASE_URL_TEMPLATE`: e.g.
  `postgres://horizon_relay:…@postgres:5432/horizon_{database}`.
- `RETENTION_INTERVAL_SECONDS` (default daily), `RETENTION_ONCE=true` for one pass.

`npm test` checks the policy; `npm run test:e2e` runs a rule against PostgreSQL as the
relay role.
