# 34. Terraform written but never applied

- Status: accepted
- Date: 2026-09-07

## Context

Horizon claims to be deployable as a distributed system on AWS. Running that stack —
five RDS instances, ECS Fargate services, an ALB, ElastiCache, Amazon MQ — costs
hundreds of dollars a month indefinitely, for a portfolio project that will be read far
more often than it is used.

Two dishonest options exist. Write no infrastructure code and describe the deployment in
prose, which is unverifiable. Or write it, never apply it, and imply that it runs.

## Decision

The Terraform is **written properly and never applied**, and that fact is stated
prominently rather than left to be inferred.

- `infra/terraform/modules/`: `network`, `ecs-service`, `rds`, `elasticache`, `mq`,
  `alb`, `ecr`, `observability`.
- `infra/terraform/envs/dev` and `envs/prod`, differing **only in variables**.
- Target: **ECS Fargate**, one service per module, ALB in front of Kong, RDS per module,
  ElastiCache, Amazon MQ, ECR, Secrets Manager.
- Remote state backend **defined** (S3 with a DynamoDB lock table), **not initialized**.
- CI runs `terraform fmt -check` and `terraform validate`. **No `apply` exists in any
  workflow**, and a CI check asserts that no workflow contains one.
- `infra/terraform/README.md` states plainly that this has never been applied, and
  **estimates the monthly cost if it were**.

Separately, Phase 11 deploys `web/` plus a minimal backend to a free tier, so something
is actually reachable. The two are not confused with each other: the live URL's README
note says exactly which parts of the architecture are running there and which are not.

## Consequences

- `validate` proves the configuration is syntactically and semantically coherent —
  provider schemas satisfied, references resolvable, types correct. It does not prove it
  would provision, and the README says so.
- The cost estimate is the most useful thing in that README. It converts an architecture
  diagram into a number, which is the question an engineering manager actually asks.
- Stating "never applied" costs some perceived credibility and buys all of the real
  kind. A reviewer who discovers an unstated gap discounts everything else in the
  repository; one who is told upfront discounts nothing.
- Drift between the compose stack and the Terraform is possible, since only one of them
  runs. Mitigated by keeping the service topology — names, ports, environment variables
  — defined in one place and referenced by both.
- Provider version pinning and `validate` in CI keep the code from rotting silently.

## Alternatives considered

**Apply it and pay.** Rejected on cost for an unbounded period.

**Apply it periodically, then destroy.** Would genuinely prove it provisions. Rejected:
it needs an AWS account with real credentials reachable from CI, and the blast radius of
a misconfigured workflow with `apply` rights is unbounded. The `no apply exists` CI check
exists precisely to keep that door shut.

**LocalStack.** Would exercise the provider calls locally. Rejected: coverage of the
services used here is partial enough that a green LocalStack run would be a weaker claim
than an honest "never applied", while implying a stronger one.

**Describe the deployment in prose only.** Rejected: unverifiable, and it skips the work.
