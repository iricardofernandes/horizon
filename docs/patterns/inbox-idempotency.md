# Inbox and HTTP idempotency

Source: `identity/src/infrastructure/database/drizzle/schema/messaging.ts`,
`identity-database.ts`, and `identity/src/infrastructure/http/idempotency-store.ts`.
Proof: database and cache e2e suites under `identity/test/`.

An inbox and an HTTP idempotency record deduplicate different things. For an event,
insert `(source_module, event_id)` inside the same tenant transaction as its effect.
If the unique key already exists, skip the handler. If the handler throws, both its
writes and the inbox insert roll back. Acknowledge the broker only after commit.
Identity has no business event consumer; its transaction helper exists to prove the
pattern before other modules copy it. Consumers must separately validate the envelope
and payload, configure bounded prefetch and own dead-letter handling.

For an HTTP write carrying an optional Idempotency-Key, claim a Redis record before
executing the handler. Include authenticated tenant, principal and endpoint in its
scope. Store a request-body digest separately: reusing a key with another body is 409,
as is a duplicate while the first execution is in flight. A successful retry returns
the original status and body. Encrypt cached credential-bearing responses; apply the
same expiry to claim and result. A crashed request may leave a pending claim until TTL;
that is safer than executing an uncertain write again immediately.

Authentication exchanges that rotate credentials keep their own session semantics;
they are explicitly excluded from response caching. Redis outage semantics and
exclusions must be stated at the HTTP boundary. Natural database constraints still
protect creation independently of a 24-hour convenience cache.

For another module, choose the source-module namespace, handler, response secrecy key,
endpoint scope and retention window. Retention must exceed the longest possible event
redelivery or client retry window. Never delete inbox history arbitrarily to save space.
