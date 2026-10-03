# AWS infrastructure definition

> **This Terraform has never been applied.** It is validated in CI without an AWS
> account, and no workflow is allowed to run `terraform apply` (ADR 0034). The public
> Vercel/Neon demo from phase 11 is a separate, reduced topology; it is not this stack.

The root stack targets ECS Fargate in two Availability Zones:
- `web` and Kong behind an Application Load Balancer;
- all sixteen business services, each scaled on its own and discovered through Cloud Map;
- one encrypted RDS PostgreSQL instance per module;
- ElastiCache Redis and Amazon MQ for RabbitMQ;
- a ClamAV daemon that only Files can reach;
- three private, versioned, server-encrypted buckets, each written only by its owner:
  fiscal documents (Fiscal), attachments (Files) and exports (Reporting);
- ECR, Secrets Manager, ADOT sidecars and CloudWatch.

The nine modules under `modules/` are the reviewable infrastructure boundaries.

### Who may call whom

- The ALB reaches only `web` and the gateway.
- The gateway reaches every business service.
- Every task carries an `internal-callers` security group. It lets `web`, Reporting,
  Knowledge and Agent call the gateway, and lets any service read Identity's JWKS. It also
  lets Fiscal read Parties and Catalog directly. No other service accepts a direct call.
- Only Files reaches ClamAV, and only the tasks reach the databases, Redis and the broker.

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
The runtime secrets each service expects in `service_secret_arns` are listed below.
Every service also needs `TENANT_ID_HASH_SALT`.

| Service | Secrets |
|---|---|
| identity | the JWT signing key, `BLIND_INDEX_KEY_PATH`, `MFA_SEAL_SECRET`, `SERVICE_CLIENTS`, `SMTP_URL` |
| catalog | `IDEMPOTENCY_SECRET` |
| sales | `CUSTOMER_BLIND_INDEX_KEY` |
| parties | `PARTY_BLIND_INDEX_KEY` |
| webhooks | `WEBHOOK_SECRET_ENCRYPTION_KEY` |
| fiscal | `FISCAL_SERVICE_KEYS_JSON`, a 32-byte `FISCAL_ARTIFACT_KEY_HEX` |
| files | `FILES_MASTER_KEY`, `FILES_LINK_SECRET` |
| reporting | `EXPORT_LINK_SECRET`, `SERVICE_TOKEN_SECRET` |
| knowledge | `KNOWLEDGE_MASTER_KEY`, `KNOWLEDGE_LEXEME_KEY`, `SERVICE_TOKEN_SECRET` |
| agent | `ASSISTANT_MASTER_KEY`, and `ANTHROPIC_API_KEY` only when generation is opted in |

Fiscal's task role has only `GetObject` and `PutObject` on the business-document
bucket. Files and Reporting may also delete in their own buckets, because Files shreds
erased attachments and Reporting expires old exports. The bucket is separate
from Terraform state, blocks public access, enables versioning and server encryption.

For artifact recovery, preserve the bucket and application encryption key together.
Restore a prior object version to the same immutable key only after comparing its
plaintext SHA-256 to `fiscal_artifacts.digest` under a tenant-scoped operator tool;
the service rechecks the digest on every read. Test this procedure in a temporary
environment before a production cutover. Bucket deletion is disabled in Terraform.

### Broker users

Each service connects to Amazon MQ as a user of its own, which may publish only its own
module's events and read only its own queues
([ADR 0075](../../docs/adr/0075-one-broker-identity-per-module.md)). Amazon MQ creates
one RabbitMQ user, the administrator, so the module users are created through the
management API once the broker is up, from a host that can reach it, before the first
service starts. The administrator and every module password are in one secret, which
no task may read, and go to the script on its standard input:

```sh
aws secretsmanager get-secret-value \
  --secret-id "$(terraform -chdir=infra/terraform output -raw mq_bootstrap_secret_arn)" \
  --query SecretString --output text \
  | node infra/scripts/broker-definitions.mjs \
      --apply "$(terraform -chdir=infra/terraform output -raw mq_console_url)" \
      --environment-json -
```

It declares `horizon.events` and `horizon.journal`, then each module's user, permissions
and topic permissions, and refuses to run while any module lacks a password of at least
16 characters; `--check` lists the users the broker still lacks. To rotate one module's
password, replace its `random_password` (`-replace='module.mq.random_password.module["sales"]'`),
run the same command, and restart that service.

## Before a first deployment

Kong's upstreams are named the way Compose names services (`http://sales:3004`). The
gateway image built for AWS rewrites them to Cloud Map's `sales.horizon.local`
([`gateway/Dockerfile`](../../gateway/Dockerfile)), so the committed `kong.yml` stays the
same for both.

These gaps are known, and this stack does not close them:
- **pgvector.** Knowledge's migration creates the `vector` extension. RDS for PostgreSQL 17
  ships it, and the owner role can create it.
- **S3 addressing.** Files and Reporting use path-style requests to the regional S3
  endpoint, with credentials from the task role. Path-style requests still work, but AWS
  plans to retire them; moving those clients to virtual-hosted style is a one-line
  change in each.
- **The retention job.** `tooling/retention` takes one connection template for every
  database, with one relay password. Here each database has its own relay secret, so the
  job needs a connection per database before it can run as a task. The synthetic probe
  does run, as a service of its own.
- **The local model.** Knowledge embeds with a deterministic hash unless `TEI_URL` names
  an embedding server. That server is not part of this stack.

No migration task is launched from Terraform. That is a release action with database
effects, while these modules only describe infrastructure. The release workflow builds
immutable images and can create a speculative plan, but has no apply step.

## Cost estimate

Estimate date: **2026-10-01**, `us-east-1`, 730 hours/month, on-demand pricing, low
traffic, no free-tier credits, support, tax, heavy log ingestion or internet egress.
These are planning ranges from published unit prices, not a quote. Use the AWS Pricing
Calculator before any real use.

| Component | Dev values | Estimated USD/month |
|---|---:|---:|
| 19 Fargate tasks, 0.25 vCPU / 0.5 GB | always on | $170–185 |
| ClamAV, 1 vCPU / 3 GB | always on | about $40 |
| 16 RDS PostgreSQL `db.t4g.micro` + 20 GB gp3 each | Single-AZ | $220–260 |
| ElastiCache `cache.t4g.micro` | 1 node | $12–25 |
| Amazon MQ RabbitMQ `mq.m7g.medium` | single instance + EBS | $85–140 |
| 1 NAT gateway | before traffic | about $33 |
| ALB, CloudWatch, about 65 secrets, ECR, three buckets | low traffic | $60–110 |
| **Dev total** | | **roughly $620–790/month** |

The production values double the tasks at 0.5 vCPU / 1 GB, make the sixteen databases
`db.t4g.small` Multi-AZ, add Redis failover, a three-node RabbitMQ cluster and one NAT
gateway per AZ. A reasonable idle or low-load range is **$2,500–3,300/month**, before
meaningful traffic and telemetry volume.

Sixteen RDS instances and Amazon MQ dominate the bill. That is the real monetary cost of
the broker and of database-per-module. The cheapest lever is one instance holding
sixteen databases, which is how the local stack runs. ADR 0016 keeps one instance per
module here because a shared cluster shares connection limits, autovacuum pressure and
its failure domain. Changing that would take a new ADR, not a variable.

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
