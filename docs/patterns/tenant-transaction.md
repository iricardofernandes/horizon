# Tenant transactions and forced RLS

Source: `identity/src/infrastructure/database/drizzle/identity-database.ts`,
`schema/`, and `migrations/`. Proof: `identity/test/database.e2e-spec.ts`.

Create a database per module and provision application, owner and relay roles outside
migrations. The application role must have neither SUPERUSER nor BYPASSRLS; the owner
runs DDL, never requests. Explicitly revoke default table privileges before granting
only the operations each role needs. Enable and FORCE RLS on every business table.
Both USING and WITH CHECK compare tenant_id with the transaction setting.

Copy the UnitOfWork port, then implement an executor with a private database client.
Begin a transaction, execute parameterized `set_config('app.current_tenant', tenantId,
true)`, and construct repositories bound to that transaction. No raw client or pool
leaves the module. Expected Either.left results commit; thrown faults roll back.
Never return an Either.left after partial business writes unless committing those
writes is intentional, as with security audit evidence.

Acquire locks in a documented order for read-modify-write operations. A tenant filter
prevents data leaks but cannot prevent a stale save from undoing revocation. Copy the
same-tenant foreign keys as well as the RLS policies: a policy alone does not prove
that referenced users or tenants exist.

For another module, replace the schema, repositories and aggregate mappings. Omit
Identity's pre-authentication directory. Prove absence of context, pooled connection
reuse, cross-tenant reads and writes, rollback and concurrent mutations using real
PostgreSQL with the unprivileged application and migration roles.
