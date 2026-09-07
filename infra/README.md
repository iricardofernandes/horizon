# `infra/`

Local orchestration, observability configuration, and the Terraform that describes the
AWS deployment.

**Status: phase 1 — scaffold.** Only `scripts/generate-keys.sh` is functional. The
compose stack and observability configuration are phase 2; Terraform is phase 13.

---

## What this project owns

- **The local platform** — `docker-compose.yml` for PostgreSQL, Redis, RabbitMQ, Kong,
  Verdaccio and the full observability plane, plus `docker-compose.apps.yml` as an
  overlay so the platform can run alone while modules run from source *(phase 2)*.
- **Observability configuration** — the OTel Collector pipeline, Prometheus scrape
  config, Loki, Grafana Alloy, and Grafana's provisioned datasources and dashboards
  *(phase 2)*.
- **Operational scripts** — key generation, and the smoke test that proves the stack is
  actually up rather than merely started.
- **Terraform** — modules and environments describing the ECS Fargate deployment
  *(phase 13)*.

## What it explicitly does not own

- **Anything that runs in production.** See below.
- **Application configuration.** Each module owns its own `.env.example` and validates
  its own configuration at boot.
- **Secrets.** It generates development keys into a gitignored path and reads nothing
  real.

---

## Terraform is written and never applied

This is stated here, in `infra/terraform/README.md`, and in ADR 0034, because a reader
who discovers an unstated gap discounts everything else in the repository.

The Terraform will be written properly — modules for network, ECS services, RDS,
ElastiCache, Amazon MQ, ALB, ECR and observability; `envs/dev` and `envs/prod` differing
only in variables; an S3 and DynamoDB state backend defined but not initialized. CI runs
`terraform fmt -check` and `terraform validate`, and a check asserts that **no workflow
contains an `apply`**.

It has never been applied and there is no AWS account behind it. `validate` proves the
configuration is coherent — provider schemas satisfied, references resolvable — not that
it would provision. The estimated monthly cost of running it is published in
`infra/terraform/README.md` when that phase lands, because turning an architecture
diagram into a number is the question an engineering manager actually asks.

Something *is* reachable: phase 11 deploys `web/` plus a minimal backend to a free tier,
with a note saying exactly which parts of the architecture are running there.

---

## Scripts

```bash
bash infra/scripts/generate-keys.sh          # Ed25519 dev keys, gitignored
bash infra/scripts/generate-keys.sh dev-2    # a second kid, to practise rotation
```

From the repository root, `make keys` does the same.
