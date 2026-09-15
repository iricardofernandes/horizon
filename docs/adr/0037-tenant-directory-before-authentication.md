# 37. A minimal tenant directory before authentication

- Status: superseded for interactive login by [0038](0038-global-account-before-workspace-selection.md)
- Date: 2026-09-10

## Context

Login starts with a workspace slug, before a validated tenant identifier exists.
Opening the tenant table to unauthenticated cross-tenant reads would expose every
future column added to it, and make an exception in the main isolation boundary.

## Decision

Store only `(slug, tenant_id)` in `tenant_directory`. The application role may read
this mapping without tenant context. Inserting a mapping requires a transaction whose
`app.current_tenant` equals that identifier, and happens in the same transaction as
sign-up. PostgreSQL enforces slug uniqueness; a preliminary existence check is only
for a useful error message and cannot replace that constraint.

`IdentityDatabase.directory` exposes resolve, slugExists and register. Registration
uses the enclosing transaction through AsyncLocalStorage and refuses calls outside it.
The raw client remains private. All business tables, including `tenants`, retain
forced RLS; the directory contains no personal data or tenant configuration.

## Consequences

Workspace handles are discoverable. Rate limiting at the gateway bounds probing;
password verification still runs for unknown accounts to avoid a cheaper login path.
A future module normally does not copy this table: it obtains tenant context from
verified claims or a validated event envelope.

## Alternatives considered

An unrestricted SELECT policy on `tenants` exposes too much. Requiring the user to
know a tenant UUID avoids lookup but makes sign-in unnecessarily awkward. A separate
service adds a synchronous dependency for two columns owned by Identity.
