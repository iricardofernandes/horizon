locals {
  name = "horizon-${var.environment}"
  tags = {
    Application = "horizon"
    Environment = var.environment
    ManagedBy   = "terraform"
    Repository  = "iricardofernandes/horizon"
  }
  business_services = {
    identity  = 3001
    catalog   = 3002
    inventory = 3003
    sales     = 3004
    webhooks  = 3005
  }
  container_names = toset(concat(keys(local.business_services), ["web", "gateway"]))
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
  services           = local.container_names
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
  ingress_security_group_ids    = [module.alb.security_group_id]
  additional_security_group_ids = [aws_security_group.data_access.id]
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
  additional_security_group_ids = [aws_security_group.data_access.id]
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

  name                          = "${local.name}-${each.key}"
  cluster_arn                   = aws_ecs_cluster.this.arn
  vpc_id                        = module.network.vpc_id
  subnet_ids                    = module.network.private_subnet_ids
  image                         = "${module.ecr.repository_urls[each.key]}:${var.image_tag}"
  container_port                = each.value
  cpu                           = var.task_cpu
  memory                        = var.task_memory
  desired_count                 = var.desired_count
  log_group_name                = module.observability.log_group_names[each.key]
  aws_region                    = var.aws_region
  ingress_security_group_ids    = [module.gateway.security_group_id]
  additional_security_group_ids = [aws_security_group.data_access.id]
  namespace_id                  = aws_service_discovery_private_dns_namespace.this.id
  discovery_name                = each.key
  environment                   = merge(local.common_environment, { PORT = tostring(each.value) })
  secrets = merge(
    lookup(var.service_secret_arns, each.key, {}),
    {
      DATABASE_URL       = module.rds.application_database_url_secret_arns[each.key]
      DATABASE_RELAY_URL = module.rds.relay_database_url_secret_arns[each.key]
      REDIS_URL          = module.elasticache.url_secret_arn
      RABBITMQ_URL       = module.mq.url_secret_arn
    },
  )
  tags = local.tags
}
