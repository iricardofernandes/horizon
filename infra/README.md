# `infra/`

Local orchestration, observability configuration, and the Terraform that describes the
AWS deployment.

**Status: phase 2 — the platform runs.** `make up && make smoke` brings up eleven
services from cold and asserts 43 things about them. Terraform is still phase 13.

---

## Quick start

```bash
make up          # start everything and wait for health
make smoke       # prove it works, not merely that it started
make down        # stop, keeping data
make clean       # stop and delete the volumes
```

`make up` generates development keys if they are missing, renders the Kong
configuration, and waits for every healthcheck. Cold start is around 30 seconds.

| Service | URL | Credentials |
|---|---|---|
| Gateway (Kong) | http://localhost:8000 | — |
| Kong admin (read-only, DB-less) | http://localhost:8001 | — |
| Grafana | http://localhost:3300 | admin / admin |
| Jaeger | http://localhost:16686 | — |
| Prometheus | http://localhost:9090 | — |
| Loki | http://localhost:3100 | — |
| RabbitMQ management | http://localhost:15672 | horizon / horizon |
| Verdaccio | http://localhost:4873 | — |
| PostgreSQL | localhost:5432 | see below |
| Redis | localhost:6379 | — |

### Port conflicts

Every published port is overridable. If something already listens on one of them, copy
`.env.example` to `.env` and change the line rather than stopping your other work:

```bash
cp infra/.env.example infra/.env
echo 'HORIZON_POSTGRES_PORT=5433' >> infra/.env
```

Container-to-container addressing is unaffected — services always reach each other by
service name and container port.

---

## What this project owns

- **The local platform** — `docker-compose.yml`: PostgreSQL 17, Redis 7, RabbitMQ 4,
  Verdaccio, Kong, the OTel Collector, Jaeger, Prometheus, Loki, Grafana Alloy and
  Grafana.
- **The application overlay** — `docker-compose.apps.yml`, adding Horizon's own services.
  Separate so the platform can run alone while a service is worked on from source, which
  is the normal development loop.
- **Observability configuration** — the Collector pipeline, Prometheus scrape config,
  Loki, Alloy, and Grafana's provisioned datasources and dashboards.
- **Database bootstrap** — `postgres/init/`: five databases and three roles.
- **Operational scripts** — key generation, Kong config rendering, token minting, smoke.
- **Terraform** *(phase 13)*.

## What it explicitly does not own

- **Anything that runs in production.** See "Terraform is written and never applied".
- **Application configuration.** Each module owns its own `.env.example` and validates
  its own configuration at boot.
- **Secrets.** It generates development keys into a gitignored path and reads nothing
  real.

---

## The three PostgreSQL roles

One container hosting five databases (ADR 0016). The role separation is what makes the
tenant isolation claim real rather than aspirational (ADR 0017):

| Role | Purpose | Notably |
|---|---|---|
| `horizon_owner` | Owns the schema, runs migrations | The application never connects as this |
| `horizon_app` | What the services connect as | `NOSUPERUSER`, `NOBYPASSRLS` — RLS applies to it |
| `horizon_debug` | The MCP debugger (ADR 0035) | No privileges on business tables; `pg_read_all_stats` only |

`make smoke` asserts that `horizon_app` is not superuser, cannot bypass RLS and cannot
create roles. If it could, every tenant-isolation test in the repository would pass
without proving anything.

---

## The observability pipeline

```
services ──OTLP──▶ Collector ──┬──▶ Jaeger      (traces)
                               ├──▶ Prometheus  (metrics, scraped from :8889)
                               └──▶ Loki        (logs)
container stdout ──▶ Alloy ────────▶ Loki
                                      ▲
                              Grafana ┘ (also Prometheus, Jaeger)
```

Nothing talks to a backend directly (ADR 0033). Services know the Collector's endpoint
and nothing else, so a backend can be swapped in one file, and a backend outage loses
visibility rather than backpressuring the application.

`make smoke` pushes one trace, one log and one metric through the Collector and then
asserts each arrived: the trace queryable in Jaeger by id, the log in Loki **carrying the
same trace id**, and the metric scraped into Prometheus. That correlation is the thing
that makes an investigation possible, so it is tested rather than assumed.

Grafana starts with its datasources and the `Horizon — service overview` dashboard
already provisioned from files. Nobody clicks anything to set the stack up.

### A note on healthchecks

Nine of the eleven services have container healthchecks. The OTel Collector and Alloy are
distroless — no shell, no health subcommand — so no healthcheck is expressible in the
compose file, and their readiness is asserted from the host by `scripts/smoke.sh`
instead. This is stated rather than silently skipped.

Healthchecks address `127.0.0.1`, not `localhost`. Inside the Verdaccio image `localhost`
resolves to `::1` first while Verdaccio binds IPv4 only, so a `localhost` healthcheck
fails against a perfectly healthy service. Using the literal address everywhere avoids
the whole class of problem.

---

## The gateway configuration is rendered

`gateway/kong.yml` is a **template**. Kong OSS verifies EdDSA but has no plugin that
fetches a JWKS document, so the public keys have to be present in the declarative
configuration. `scripts/render-kong-config.sh` injects them into
`generated/kong.generated.yml` (gitignored), which is what the container mounts.

```bash
make keys           # generate an Ed25519 keypair (gitignored)
make keys ARGS=dev-2 # a second kid, to practise rotation
make kong-config    # re-render after a key change
```

The full reasoning, and what was rejected, is in
[ADR 0036](../docs/adr/0036-kong-oss-has-no-jwks-so-the-gateway-config-is-rendered.md).

`make smoke` mints a token with the dev key and calls `/gateway/verify` — a route with no
upstream, answered directly by `request-termination` — expecting 200. It then calls with
a token signed by a freshly generated key the gateway has never seen, expecting 401. That
second check is the one that matters.

---

## Scripts

| Script | Purpose |
|---|---|
| `scripts/generate-keys.sh` | Ed25519 keypair plus a blind-index key, into a gitignored path |
| `scripts/render-kong-config.sh` | Kong template + public keys → runnable declarative config |
| `scripts/mint-dev-token.mjs` | Mint an EdDSA token; `--bogus` signs with an unknown key |
| `scripts/smoke.sh` | 43 assertions about a running platform |

`mint-dev-token.mjs` uses `node:crypto` and no dependencies, because the repository root
has no `package.json` (ADR 0001).

---

## Terraform is written and never applied

Stated here, in `terraform/README.md` when that phase lands, and in
[ADR 0034](../docs/adr/0034-terraform-written-but-never-applied.md), because a reader who
discovers an unstated gap discounts everything else in the repository.

Modules for network, ECS services, RDS, ElastiCache, Amazon MQ, ALB, ECR and
observability; `envs/dev` and `envs/prod` differing only in variables; an S3 and DynamoDB
state backend defined but not initialized. CI runs `terraform fmt -check` and
`terraform validate`, and `scripts/assert-no-terraform-apply.mjs` fails the build if any
workflow could apply it.

It has never been applied and there is no AWS account behind it. `validate` proves the
configuration is coherent, not that it would provision. The estimated monthly cost of
running it is published alongside the code when that phase lands.

Something *is* reachable: phase 11 deploys `web/` plus a minimal backend to a free tier,
with a note saying exactly which parts of the architecture are running there.
