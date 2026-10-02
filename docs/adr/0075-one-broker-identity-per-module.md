# 75. Each module has a broker identity of its own, and publishes only its own events

- Status: accepted. Implemented in Phase 90 ([plan](../security-logic-plan.md)).
- Date: 2026-10-02

## Context

Until Phase 90 every module connected to RabbitMQ as the same administrator, `horizon`.
A consumer applies an event because its routing key and `eventType` say who published it,
and Treasury and Ledger move money on `financial.settlement.recorded`. One compromised
module, or a bug in one, could therefore:
- publish any other module's event, and every consumer would apply it;
- write to the default exchange, which reaches any queue by name, or to the journal as
  another module, and seal a source that never sent it;
- read, purge or delete another module's queues, and fill its dead-letter queue through
  the exchange every queue dead-lettered into.

ADR 0016 gives each module its own database so that persistence does not undo the boundary
the source enforces, with no read access to another module's data. One shared broker
credential undid that boundary on the bus.

## Decision

1. **Each module connects as a user of its own**, named after it, with a password of its
   own. The administrator is the operator's alone: no service, and no task on AWS, holds it.
   - Locally, `make broker-config` renders the users into the definitions RabbitMQ imports
     at boot.
   - On Amazon MQ, `infra/scripts/broker-definitions.mjs --apply` creates them through the
     management API, from a secret no task may read.
2. **A module may publish only its own events.** ADR 0030 names every event
   `<module>.<aggregate>.<verb>`, so a topic permission on `horizon.events` narrows each
   publisher to `^<module>\.`. A module that only consumes may not write to the exchange at
   all, and one that only publishes may not read it.
3. **No module may write to the default exchange.** The journal resends and seals of ADR
   0058 go through a topic exchange of their own, `horizon.journal`, under the same rule:
   `<module>.<aggregate>.<verb>` for an event, `<module>.seal` for a seal. Only Reporting
   reads it.
4. **A module declares, binds and reads only names that start with `<module>.`:** its
   queues, and their dead-letter exchanges. Each queue dead-letters into an exchange of its
   own, `<queue>.dlx`, bound to `<queue>.dlq` alone. The shared `horizon.events.dlx` and its
   headers router of Phase 79 are gone.
5. **A consumer refuses a message that is not the event it claims to be.** It dead-letters,
   without applying it, a message whose routing key differs from the `eventType` of its
   body, or from `<source>.seal` for a seal. The broker vouches for the key, and the key
   for the body. A message put back through the default exchange is the operator's, and is
   accepted.

## Consequences

- One module can no longer forge another's events or seals, read its queues, or poison
  its dead letters.
- Adding a module means a user in `infra/scripts/broker-definitions.mjs` and its secret in
  Terraform. Without it the module cannot even connect.
- Two residual risks remain, accepted for now:
  - Each module may configure `horizon.events`, so it could delete the exchange. That is
    a denial of service, not a forgery: no event can be sent in its name.
  - Every consumer may read any routing key on `horizon.events`. A module could bind
    its own queue to events it does not need, and read their payloads. Narrowing the topic
    read pattern per consumer is possible, but only together with each module's binding
    list.
- RabbitMQ refuses a topic permission on an exchange that does not exist, so the
  definitions declare `horizon.events` and `horizon.journal` before any module starts.

## Alternatives considered

- **Sign every event, and verify the signature in each consumer.** Rejected for now:
  - it needs a key per module, its distribution and its rotation;
  - the broker already authenticates each connection, so the same guarantee comes from
    its permissions.
- **One exchange per producer.** Rejected: every consumer's bindings, the outbox relay and
  ADR 0030's routing keys would change. A topic permission enforces the same thing on the
  existing exchange.
- **Keep the shared dead-letter exchange, and only narrow publishing.** Rejected: any
  module with write on `horizon.events.dlx` could fill another's dead-letter queue, and
  the headers router trusted a header the publisher sets.
