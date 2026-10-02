# Phase 90 evidence — Who may speak on the bus, and where webhooks may go

[Plan](security-logic-plan.md#phase-90--who-may-speak-on-the-bus-and-where-webhooks-may-go) ·
[ADR 0075](adr/0075-one-broker-identity-per-module.md) ·
[smoke](drills/2026-10-02-phase90-bus-identity-smoke.json)

Findings 1, 2 and 11 of the [security and logic review](security-logic-plan.md).

## The bus, before and after

| | Before | After |
|---|---|---|
| Who each service connects as | `horizon`, the administrator | `<module>`, a user of its own; the administrator is the operator's alone |
| Who may publish `financial.settlement.recorded` | every service | Financial |
| The default exchange, which reaches any queue by name | every service could write to it | only the operator |
| Journal resends and seals (ADR 0058) | through the default exchange, straight into `reporting.replay` | through `horizon.journal`, each module under `<module>.*` only |
| Dead letters | every queue into the shared `horizon.events.dlx`, routed by a header | each queue into `<queue>.dlx`, bound to its own DLQ alone |
| A message whose routing key is not the event its body names | applied | dead-lettered, nothing applied |
| A module that only publishes (Identity, Parties) | could read every event | may not read the shared exchange |
| On AWS | every task held the administrator's AMQPS URL | each task holds its own; the administrator is in a secret no task may read |

## Webhooks, before and after

| | Before | After |
|---|---|---|
| Endpoint | any HTTPS host; plain HTTP to `localhost` | public HTTPS only; plain HTTP to the loopback only under `WEBHOOK_ALLOW_LOOPBACK` |
| When it is checked | when subscribing, by its scheme | when subscribing, by address and by the name's current resolution; and at each connection, on the address the socket uses |
| A name that later resolves inside the network | delivered to | refused: `refused: not a public address` |
| What an attempt records of a failure | the error's own text | a category: `HTTP <status>`, `timeout`, `dns`, `tls`, `connection failed`, `refused: not a public address` |

The reserved ranges are private, loopback, link-local (cloud metadata included),
carrier-grade NAT, documentation, benchmarking, multicast, reserved, the 6to4 and NAT64
prefixes, unique-local, and every IPv4-mapped IPv6 address.

## Dependencies

| Package | From → to | Where |
|---|---|---|
| `@grpc/grpc-js` | 1.14.4 → 1.14.5 | Identity, Catalog, Inventory, Sales, Webhooks, Parties, Financial, Treasury, Ledger |
| `brace-expansion` | 2.1.4 → 2.1.7 | the same, except Ledger |
| `multer`, with `@nestjs/platform-express` | 2.2.0 → 2.4.0, 12.0.1 → 12.1.2 | Parties, Financial, Treasury |
| `fast-uri`, `ip-address` | 3.1.7 → 3.1.8, 10.7.0 → 10.7.3 | the MCP debugger |

Each within its declared range, through the lockfile alone. `npm audit --omit=dev` now
reports nothing, at any severity, in all nineteen projects.

## Proof

- **The smoke** (`node scripts/phase90-smoke.mjs`), 14 of 14 against the migrated stack:
  - the broker holds exactly the rendered users, permissions and topic permissions;
  - all sixteen services are connected, each as its own module, none as the operator;
  - the broker refuses Sales publishing Financial's event, writing to the default
    exchange, sealing as Financial in the journal, writing to Ledger's dead-letter
    exchange, declaring a Financial queue and reading Financial's queue, each with
    `ACCESS_REFUSED` naming the resource; and Webhooks publishing anything;
  - the MCP debugger lists queues, and may neither read nor publish a message;
  - all sixteen queues dead-letter into an exchange of their own, and no shared one is left;
  - a webhook to `169.254.169.254`, `10.0.0.5`, `localhost`, plain HTTP, and to `rabbitmq`
    and `postgres` by name is `400`; a public one is `201`;
  - no DLQ grew during the run.
- **The Phase 79 smoke**, 5 of 5 on the new topology. Treasury, Ledger and Procurement
  seal a workspace that never used them, through `horizon.journal` as themselves, and the
  watermarks move.
- **e2e tests, against real RabbitMQ:**
  - Sales: an item event sent under another event's routing key is dead-lettered, and
    neither a projection nor an inbox row is written;
  - Reporting: the replay goes through `horizon.journal`. A seal under another module's
    key is dead-lettered, and the watermark does not move;
  - Fiscal: a message published straight into another queue's dead-letter exchange never
    reaches Fiscal's DLQ;
  - the seven journal producers: each message goes out under its own module's key.
- **Unit tests:**
  - Webhooks, 15: each reserved range; HTTPS, credentials and the development
    loopback; a name that resolves inside the network now, on the socket's own lookup; no
    redirect followed; a timeout; failures kept as categories; a name resolved when
    subscribing;
  - the broker definitions, 13: each permission and topic permission, the password hash
    RabbitMQ checks, and the shared exchanges declared.
- **The AWS path,** without AWS:
  - `--apply` against a throwaway broker whose only user was its own administrator, as on
    Amazon MQ. It created 16 module users and 24 topic permissions, and no administrator.
  - Sales could then publish `sales.order.placed`, and was refused
    `financial.settlement.recorded`.
  - Terraform `validate`, and its tests with the dev and prod variables, pass; a new
    assertion requires one broker secret per service.

## Gates

- `make demo`, twice, on the migrated stack: the order, the reservation, the dispatch and
  the money, with the signed callback delivered once through the new client; no DLQ
  holds a message afterwards.
- `make test-phase10`: the golden path in Chromium, through the real Webhooks service,
  which takes the public endpoint it subscribes.
- `make test-alerts`: the alert rules check and their unit tests pass.
- `node scripts/ci-local.mjs --full`: the first run failed only on the formatting of the
  new Sales e2e test, since fixed. The second, after the last code edit, passed: every
  check, the secret scan, clean installs, typecheck, lint, tests and build of every
  project, the e2e suites of all sixteen services, and every Docker image.
- `deck` did not run: `gateway/kong.yml` is unchanged.
- The platform smoke (`infra/scripts/smoke.sh`) passes every check but one, "16 module
  databases exist". It counts 17 because a recovery drill left `horizon_drill` in the local
  PostgreSQL, which is not this phase's doing; its RabbitMQ checks pass.

## Found on the way

1. **Recreating the local broker emptied it.** The Compose service had no fixed hostname,
   and RabbitMQ keeps its state under `rabbit@<hostname>`, so every new container started
   empty and its dead letters were lost. It is now `hostname: rabbitmq`. The state of the
   last container is still in the volume, under `rabbit@bf33c8d96325`, unused.
2. **RabbitMQ refuses a topic permission on an exchange that does not exist.** A fresh
   broker failed to boot. The definitions now declare `horizon.events` and
   `horizon.journal`, which RabbitMQ 4.3 imports before topic permissions, and `--apply`
   declares them first.
3. **The first `--apply` would have weakened a remote broker.** On a broker whose
   administrator has another name, it would have created a second administrator,
   `horizon`, with the local default password, and it took `<module>-local` for any
   password not set. It now creates module users only, and refuses to run while a module
   lacks a password of 16 characters or more.
4. **One list of reserved ranges refused every IPv4 address.** Node's `BlockList` checks
   an IPv4 address against IPv6 rules as if IPv4-mapped, so `::ffff:0:0/96` matched
   `8.8.8.8`. Each family has a list of its own.
5. **Parties consumes nothing.** Its transport has a consumer class that is never started,
   so Parties, like Identity, now publishes and may not read.

## The migration, as run locally

1. Stop the sixteen services; no queue had a message in flight.
2. `node scripts/migrate-broker-identities.mjs --apply`: it deleted the sixteen queues
   declared the old way, all empty and unused, then `horizon.dead-letters` and
   `horizon.events.dlx`.
3. `make broker-config`, then recreate the broker.
4. `make up-apps` and `make up-fiscal`, with images rebuilt from this phase's code. Each
   service declares its queue again, with its own dead-letter exchange.

## Residual risks

- Each module may configure `horizon.events`, so it could delete it: a denial of
  service, not a forgery.
- Every consumer may bind any routing key, and so read events it does not need.
- Locally, the operator's scripts (`make demo`, `scripts/dead-letters.mjs`, the smokes)
  sign in as `horizon` / `horizon`.
- A subscription made before this phase to an address inside the network is not
  deleted. Each of its deliveries is refused when connecting, and ends as a dead letter.
