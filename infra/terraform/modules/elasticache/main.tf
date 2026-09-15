variable "name" { type = string }
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }
variable "allowed_security_group_ids" { type = list(string) }
variable "node_type" { type = string }
variable "replicas" { type = number }
variable "automatic_failover" { type = bool }
variable "tags" {
  type    = map(string)
  default = {}
}

resource "aws_elasticache_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.subnet_ids
}

resource "aws_security_group" "this" {
  name_prefix = "${var.name}-redis-"
  description = "Redis from Horizon ECS tasks only"
  vpc_id      = var.vpc_id
  dynamic "ingress" {
    for_each = toset(var.allowed_security_group_ids)
    content {
      from_port       = 6379
      to_port         = 6379
      protocol        = "tcp"
      security_groups = [ingress.value]
    }
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = var.tags
}

resource "random_password" "auth" {
  length  = 32
  special = false
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id       = var.name
  description                = "Horizon Redis"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = var.node_type
  port                       = 6379
  num_cache_clusters         = var.replicas + 1
  automatic_failover_enabled = var.automatic_failover
  multi_az_enabled           = var.automatic_failover
  subnet_group_name          = aws_elasticache_subnet_group.this.name
  security_group_ids         = [aws_security_group.this.id]
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = random_password.auth.result
  apply_immediately          = false
  snapshot_retention_limit   = 7
  tags                       = var.tags
}

resource "aws_secretsmanager_secret" "url" {
  name                    = "${var.name}/redis-url"
  recovery_window_in_days = 7
  tags                    = var.tags
}

resource "aws_secretsmanager_secret_version" "url" {
  secret_id = aws_secretsmanager_secret.url.id
  secret_string = format(
    "rediss://:%s@%s:6379",
    urlencode(random_password.auth.result),
    aws_elasticache_replication_group.this.primary_endpoint_address,
  )
}

output "security_group_id" { value = aws_security_group.this.id }
output "url_secret_arn" {
  value = aws_secretsmanager_secret.url.arn
}
