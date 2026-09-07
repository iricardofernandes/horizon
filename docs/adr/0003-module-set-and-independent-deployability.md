# 3. Module set and independent deployability

- Status: accepted
- Date: 2026-09-07

## Context

An ERP has no natural stopping point. Deciding which bounded contexts exist now, and
which are declared but unbuilt, determines whether the repository reads as a system
or as an unfinished sprawl.

A second question is what "independently deployable" costs. Every service added is a
container, a database, a Kong route, a set of dashboards and a CI matrix entry.

## Decision

The modules in scope are fixed:

| Folder | Responsibility | Shape |
|---|---|---|
| `identity/` | Tenants, users, authentication, sessions, API keys, JWKS, RBAC assignment | Nest service |
| `catalog/` | Products, services, units of measure, price lists, NCM classification | Nest service |
| `inventory/` | Stock balances, movements, warehouses, reservations, cost method | Nest service |
| `sales/` | Customers, quotes, sales orders, invoicing trigger | Nest service |
| `webhooks/` | Subscriptions, HMAC-signed delivery, retry, DLQ, replay | Nest service |
| `web/` | Frontend | Next.js app |
| `contracts/` | Versioned Zod event and API schemas | Published npm package |
| `gateway/` | Kong declarative configuration | Config + lint script |
| `infra/` | Terraform, compose, observability configs | Config + scripts |
| `tooling/mcp-debugger/` | Read-only MCP server over the observability plane | Node package |

The five Nest services are independently deployable: own container, own port, own
database, behind Kong.

**There is no central audit module.** Audit is a local append-only table inside each
module (ADR 0025). A central audit service would be a synchronous dependency on every
write path in the system, and its failure would either block writes or silently lose
the audit trail.

`financial/` and `fiscal/` are roadmap only. **Their folders do not exist** until
their phase begins.

The non-service projects do not all need the full project profile of ADR 0001.
`contracts/` has no Dockerfile and no Drizzle config; `gateway/` and `infra/` are
configuration trees with scripts, not runtimes. Each project's actual profile is
stated in `docs/architecture.md`; the ADR 0001 rule about self-containment applies to
all of them, the specific file list does not.

## Consequences

- Five databases, five containers, five CI matrix entries, five sets of migrations.
- Cross-context reads require an HTTP call or a locally-maintained projection built
  from events. There is no join across module databases, ever.
- Audit queries are per-module. Answering "everything this user did" means querying
  five modules. Accepted: the alternative couples every write to a shared service.
- The module set is small enough that the golden path (Phase 8) can traverse a
  meaningful part of it in one trace.

## Alternatives considered

**A modular monolith with one database and enforced module boundaries.** Simpler,
faster, and defensible in production. Rejected because the project's stated purpose is
to demonstrate distributed-systems engineering: an outbox, an inbox, RLS across
independent databases and cross-service tracing are not exercised by a monolith.

**Finer-grained services** (separate `auth`, `users`, `tenants`). Rejected: it
multiplies operational surface without adding a distinct problem to solve.

**A central audit service.** Rejected as described above.
