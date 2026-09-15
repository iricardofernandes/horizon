# AWS infrastructure definition

> **This Terraform has never been applied.** It is validated in CI without an AWS
> account, and no workflow is allowed to run `terraform apply` (ADR 0034). The public
> Vercel/Neon demo from phase 11 is a separate, reduced topology; it is not this stack.

The root stack targets ECS Fargate in two Availability Zones: `web` and Kong behind an
Application Load Balancer; five independently scalable application services discovered
through Cloud Map; one encrypted RDS PostgreSQL instance per module; ElastiCache Redis;
Amazon MQ for RabbitMQ; ECR; Secrets Manager; ADOT sidecars and CloudWatch. The eight
modules under `modules/` are the reviewable infrastructure boundaries.

`envs/dev` and `envs/prod` contain values only. Both feed the exact same root module, so
production is not a separately copied topology. The production values add two tasks per
service, Multi-AZ databases, Redis failover, a three-node RabbitMQ cluster, longer
retention and one NAT gateway per AZ.

## State is declared, not initialized

The `backend "s3"` block is intentionally partial. Each `backend.hcl` declares an S3
bucket and DynamoDB lock table that must be created out of band; the committed names are
obvious placeholders. CI runs only:

```bash
terraform -chdir=infra/terraform init -backend=false
terraform -chdir=infra/terraform fmt -check -recursive
terraform -chdir=infra/terraform validate
terraform -chdir=infra/terraform test -var-file=envs/dev/terraform.tfvars.example
terraform -chdir=infra/terraform test -var-file=envs/prod/terraform.tfvars.example
```

An authorized operator would first create the state bucket with versioning and blocking
of all public access, create the lock table with a string `LockID` partition key, replace
the placeholders, and then initialize one environment explicitly. That operation has
never been performed for this repository.

## Runtime bootstrap deliberately remains separate

Terraform creates distinct owner, application and relay connection secrets per database.
Before services can start, a one-shot, audited migration task must use the owner secret
to create the `horizon_app` and `horizon_relay` roles with the generated passwords and
run that module's migrations. Identity key material and application encryption keys are
pre-provisioned by a security bootstrap and passed as Secrets Manager ARNs through
`service_secret_arns`; secret values never belong in `tfvars` or image layers.

No migration task is launched from Terraform. That is a release action with database
effects, while these modules only describe infrastructure. The release workflow builds
immutable images and can create a speculative plan, but has no apply step.

## Cost estimate

Estimate date: **2026-09-14**, `us-east-1`, 730 hours/month, on-demand pricing, low
traffic, no free-tier credits, support, tax, heavy log ingestion or internet egress.
These are planning ranges, not a quote; use AWS Pricing Calculator before any real use.

| Component | Dev values | Estimated USD/month |
|---|---:|---:|
| 7 Fargate tasks, 0.25 vCPU / 0.5 GB | always on | $60–75 |
| 5 RDS PostgreSQL `db.t4g.micro` + 100 GB gp3 | Single-AZ | $75–110 |
| ElastiCache `cache.t4g.micro` | 1 node | $12–25 |
| Amazon MQ RabbitMQ `mq.m7g.medium` | single instance + EBS | $85–140 |
| 1 NAT gateway | before traffic | about $33 |
| ALB, CloudWatch, Secrets Manager, ECR | low traffic | $30–70 |
| **Dev total** | | **roughly $295–453/month** |

The production variable set roughly doubles Fargate, database and NAT capacity, adds
Redis failover, and changes RabbitMQ to a three-node cluster. A reasonable idle/low-load
planning range is **$1,100–1,800/month**, before meaningful traffic and telemetry volume.
Amazon MQ and five separate RDS instances dominate; that is the real monetary cost of
the architecture's broker and database-per-module boundaries.

The estimate intentionally does not claim a calculator export because the stack has not
been planned against an account. AWS bills Fargate by requested vCPU/memory duration,
RDS by instance/storage/backup dimensions, MQ by broker instance and EBS storage, ALB by
hours plus LCUs, and NAT gateways by hours plus processed bytes. Recalculate those rates
for the target region and date using the official [Fargate](https://aws.amazon.com/fargate/pricing/),
[RDS for PostgreSQL](https://aws.amazon.com/rds/postgresql/pricing/),
[Amazon MQ](https://aws.amazon.com/amazon-mq/pricing/),
[ElastiCache](https://aws.amazon.com/elasticache/pricing/),
[ALB](https://aws.amazon.com/elasticloadbalancing/pricing/) and
[VPC](https://aws.amazon.com/vpc/pricing/) pricing pages.
