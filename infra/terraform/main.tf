locals {
  name = "horizon-${var.environment}"
  tags = {
    Application = "horizon"
    Environment = var.environment
    ManagedBy   = "terraform"
    Repository  = "iricardofernandes/horizon"
  }
  # Every business service, its port, and whether it runs an outbox relay. Each gets its
  # own RDS instance, ECR repository, log group, ECS service and Cloud Map name.
  business_services = {
    identity    = { port = 3001, relay = true }
    catalog     = { port = 3002, relay = true }
    inventory   = { port = 3003, relay = true }
    sales       = { port = 3004, relay = true }
    webhooks    = { port = 3005, relay = true }
    parties     = { port = 3006, relay = true }
    financial   = { port = 3007, relay = true }
    treasury    = { port = 3008, relay = true }
    ledger      = { port = 3009, relay = true }
    procurement = { port = 3010, relay = true }
    fiscal      = { port = 3011, relay = false }
    crm         = { port = 3012, relay = true }
    reporting   = { port = 3013, relay = true }
    files       = { port = 3014, relay = true }
    agent       = { port = 3015, relay = false }
    knowledge   = { port = 3016, relay = true }
  }
  # Services other services call directly rather than through the gateway: every service
  # reads Identity's JWKS, and Fiscal reads owner profiles from Parties and Catalog.
  called_directly = toset(["identity", "parties", "catalog"])
  container_names = toset(concat(keys(local.business_services), ["web", "gateway"]))
  gateway_url     = "http://gateway.horizon.local:8000"
  s3_endpoint     = "https://s3.${var.aws_region}.amazonaws.com"
  service_environment = {
    fiscal = {
      PARTIES_URL            = "http://parties.horizon.local:3006"
      IDENTITY_URL           = "http://identity.horizon.local:3001"
      CATALOG_URL            = "http://catalog.horizon.local:3002"
      FISCAL_ARTIFACT_BUCKET = module.fiscal_documents.bucket
      FISCAL_ARTIFACT_REGION = var.aws_region
    }
    files = {
      FILES_STORE       = "s3"
      FILES_BUCKET      = module.attachments.bucket
      FILES_S3_ENDPOINT = local.s3_endpoint
      FILES_S3_REGION   = var.aws_region
      FILES_SCANNER     = "clamav"
      CLAMD_HOST        = "clamav.horizon.local"
      CLAMD_PORT        = "3310"
    }
    reporting = {
      GATEWAY_URL        = local.gateway_url
      EXPORT_STORE       = "s3"
      EXPORT_BUCKET      = module.exports.bucket
      EXPORT_S3_ENDPOINT = local.s3_endpoint
      EXPORT_S3_REGION   = var.aws_region
    }
    agent     = { GATEWAY_URL = local.gateway_url }
    knowledge = { GATEWAY_URL = local.gateway_url }
  }
  common_environment = {
    NODE_ENV                    = "production"
    LOG_LEVEL                   = "info"
    TRUST_GATEWAY_JWT           = "false"
    JWKS_URL                    = "http://identity.horizon.local:3001/.well-known/jwks.json"
    OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf"
  }
}

module "network" {
  source             = "./modules/network"
  name               = local.name
  cidr               = var.vpc_cidr
  nat_gateway_per_az = var.nat_gateway_per_az
  tags               = local.tags
}

resource "aws_security_group" "data_access" {
  name_prefix = "${local.name}-data-access-"
  description = "Shared identity for ECS tasks allowed to reach private data services"
  vpc_id      = module.network.vpc_id
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = local.tags
}

resource "aws_security_group" "internal_callers" {
  name_prefix = "${local.name}-internal-callers-"
  description = "Marks ECS tasks allowed to call the gateway and the directly called services"
  vpc_id      = module.network.vpc_id
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = local.tags
}

module "ecr" {
  source      = "./modules/ecr"
  names       = local.container_names
  name_prefix = local.name
  tags        = local.tags
}

module "alb" {
  source          = "./modules/alb"
  name            = local.name
  vpc_id          = module.network.vpc_id
  subnet_ids      = module.network.public_subnet_ids
  certificate_arn = var.certificate_arn
  tags            = local.tags
}

resource "aws_ecs_cluster" "this" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
  tags = local.tags
}

resource "aws_service_discovery_private_dns_namespace" "this" {
  name        = "horizon.local"
  description = "Horizon ECS service discovery"
  vpc         = module.network.vpc_id
  tags        = local.tags
}

module "observability" {
  source             = "./modules/observability"
  name               = local.name
  services           = setunion(local.container_names, ["clamav"])
  log_retention_days = var.log_retention_days
  alb_arn_suffix     = module.alb.arn_suffix
  tags               = local.tags
}

module "rds" {
  source                     = "./modules/rds"
  name_prefix                = local.name
  database_names             = toset(keys(local.business_services))
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.private_subnet_ids
  allowed_security_group_ids = [aws_security_group.data_access.id]
  instance_class             = var.rds_instance_class
  allocated_storage          = var.rds_allocated_storage
  multi_az                   = var.rds_multi_az
  deletion_protection        = var.rds_deletion_protection
  backup_retention_days      = var.backup_retention_days
  tags                       = local.tags
}

module "elasticache" {
  source                     = "./modules/elasticache"
  name                       = local.name
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.private_subnet_ids
  allowed_security_group_ids = [aws_security_group.data_access.id]
  node_type                  = var.redis_node_type
  replicas                   = var.redis_replicas
  automatic_failover         = var.redis_automatic_failover
  tags                       = local.tags
}

module "mq" {
  source                     = "./modules/mq"
  name                       = local.name
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.private_subnet_ids
  allowed_security_group_ids = [aws_security_group.data_access.id]
  instance_type              = var.mq_instance_type
  deployment_mode            = var.mq_deployment_mode
  module_users               = toset(keys(local.business_services))
  tags                       = local.tags
}

module "gateway" {
  source                        = "./modules/ecs-service"
  name                          = "${local.name}-gateway"
  cluster_arn                   = aws_ecs_cluster.this.arn
  vpc_id                        = module.network.vpc_id
  subnet_ids                    = module.network.private_subnet_ids
  image                         = "${module.ecr.repository_urls["gateway"]}:${var.image_tag}"
  container_port                = 8000
  cpu                           = var.task_cpu
  memory                        = var.task_memory
  desired_count                 = var.desired_count
  log_group_name                = module.observability.log_group_names["gateway"]
  aws_region                    = var.aws_region
  ingress_security_group_ids    = [module.alb.security_group_id, aws_security_group.internal_callers.id]
  additional_security_group_ids = [aws_security_group.data_access.id, aws_security_group.internal_callers.id]
  target_group_arn              = module.alb.gateway_target_group_arn
  attach_to_load_balancer       = true
  namespace_id                  = aws_service_discovery_private_dns_namespace.this.id
  discovery_name                = "gateway"
  readonly_root_filesystem      = false
  environment = {
    KONG_DATABASE     = "off"
    KONG_PROXY_LISTEN = "0.0.0.0:8000"
    KONG_ADMIN_LISTEN = "off"
    KONG_DNS_RESOLVER = "169.254.169.253"
    KONG_PLUGINS      = "bundled"
  }
  tags = local.tags
}

module "web" {
  source                        = "./modules/ecs-service"
  name                          = "${local.name}-web"
  cluster_arn                   = aws_ecs_cluster.this.arn
  vpc_id                        = module.network.vpc_id
  subnet_ids                    = module.network.private_subnet_ids
  image                         = "${module.ecr.repository_urls["web"]}:${var.image_tag}"
  container_port                = 3000
  cpu                           = var.task_cpu
  memory                        = var.task_memory
  desired_count                 = var.desired_count
  log_group_name                = module.observability.log_group_names["web"]
  aws_region                    = var.aws_region
  ingress_security_group_ids    = [module.alb.security_group_id]
  additional_security_group_ids = [aws_security_group.data_access.id, aws_security_group.internal_callers.id]
  target_group_arn              = module.alb.web_target_group_arn
  attach_to_load_balancer       = true
  namespace_id                  = aws_service_discovery_private_dns_namespace.this.id
  discovery_name                = "web"
  environment = {
    NODE_ENV             = "production"
    HORIZON_UPSTREAM_URL = "http://gateway.horizon.local:8000"
  }
  secrets = lookup(var.service_secret_arns, "web", {})
  tags    = local.tags
}

module "service" {
  for_each = local.business_services
  source   = "./modules/ecs-service"

  name           = "${local.name}-${each.key}"
  cluster_arn    = aws_ecs_cluster.this.arn
  vpc_id         = module.network.vpc_id
  subnet_ids     = module.network.private_subnet_ids
  image          = "${module.ecr.repository_urls[each.key]}:${var.image_tag}"
  container_port = each.value.port
  cpu            = var.task_cpu
  memory         = var.task_memory
  desired_count  = var.desired_count
  log_group_name = module.observability.log_group_names[each.key]
  aws_region     = var.aws_region
  ingress_security_group_ids = concat(
    [module.gateway.security_group_id],
    contains(local.called_directly, each.key) ? [aws_security_group.internal_callers.id] : [],
  )
  additional_security_group_ids = [aws_security_group.data_access.id, aws_security_group.internal_callers.id]
  namespace_id                  = aws_service_discovery_private_dns_namespace.this.id
  discovery_name                = each.key
  environment = merge(
    local.common_environment,
    { PORT = tostring(each.value.port) },
    lookup(local.service_environment, each.key, {}),
  )
  secrets = merge(
    lookup(var.service_secret_arns, each.key, {}),
    {
      DATABASE_URL = module.rds.application_database_url_secret_arns[each.key]
      REDIS_URL    = module.elasticache.url_secret_arn
      RABBITMQ_URL = module.mq.module_url_secret_arns[each.key]
    },
    each.value.relay ? { DATABASE_RELAY_URL = module.rds.relay_database_url_secret_arns[each.key] } : {},
  )
  tags = local.tags
}

# ClamAV scans every attachment before Files serves it. Only Files may reach it.
module "clamav" {
  source                     = "./modules/ecs-service"
  name                       = "${local.name}-clamav"
  cluster_arn                = aws_ecs_cluster.this.arn
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.private_subnet_ids
  image                      = var.clamav_image
  container_port             = 3310
  cpu                        = var.clamav_cpu
  memory                     = var.clamav_memory
  desired_count              = 1
  log_group_name             = module.observability.log_group_names["clamav"]
  aws_region                 = var.aws_region
  ingress_security_group_ids = [module.service["files"].security_group_id]
  namespace_id               = aws_service_discovery_private_dns_namespace.this.id
  discovery_name             = "clamav"
  readonly_root_filesystem   = false
  tags                       = local.tags
}

# Business documents, attachments and exports: each in its own private, versioned,
# encrypted bucket, written only by the service that owns it.
module "fiscal_documents" {
  source                   = "./modules/private-bucket"
  name_prefix              = "${local.name}-fiscal-documents"
  data_class               = "fiscal-documents"
  reader_writer_role_names = { fiscal = module.service["fiscal"].task_role_name }
  tags                     = local.tags
}

module "attachments" {
  source                   = "./modules/private-bucket"
  name_prefix              = "${local.name}-attachments"
  data_class               = "attachments"
  reader_writer_role_names = { files = module.service["files"].task_role_name }
  allow_delete             = true
  tags                     = local.tags
}

module "exports" {
  source                   = "./modules/private-bucket"
  name_prefix              = "${local.name}-exports"
  data_class               = "exports"
  reader_writer_role_names = { reporting = module.service["reporting"].task_role_name }
  allow_delete             = true
  tags                     = local.tags
}
