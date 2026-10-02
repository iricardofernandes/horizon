variable "name" { type = string }
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }
variable "allowed_security_group_ids" { type = list(string) }
variable "instance_type" { type = string }
variable "deployment_mode" { type = string }
variable "module_users" {
  description = "One broker user per module, publishing only its own events (ADR 0075)."
  type        = set(string)
}
variable "tags" {
  type    = map(string)
  default = {}
}

resource "aws_security_group" "this" {
  name_prefix = "${var.name}-mq-"
  description = "AMQPS from Horizon ECS tasks only"
  vpc_id      = var.vpc_id
  dynamic "ingress" {
    for_each = toset(var.allowed_security_group_ids)
    content {
      from_port       = 5671
      to_port         = 5671
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

resource "random_password" "password" {
  length  = 32
  special = false
}

resource "aws_mq_broker" "this" {
  broker_name                = var.name
  engine_type                = "RabbitMQ"
  engine_version             = "4.3"
  host_instance_type         = var.instance_type
  deployment_mode            = var.deployment_mode
  publicly_accessible        = false
  subnet_ids                 = var.deployment_mode == "SINGLE_INSTANCE" ? [var.subnet_ids[0]] : var.subnet_ids
  security_groups            = [aws_security_group.this.id]
  auto_minor_version_upgrade = true
  logs { general = true }
  user {
    username = "horizon"
    password = random_password.password.result
  }
  tags = var.tags
}

# Each module connects as a user of its own (ADR 0075); no task holds the administrator.
resource "random_password" "module" {
  for_each = var.module_users
  length   = 32
  special  = false
}

resource "aws_secretsmanager_secret" "module_url" {
  for_each                = var.module_users
  name                    = "${var.name}/amqp-url/${each.key}"
  recovery_window_in_days = 7
  tags                    = var.tags
}

resource "aws_secretsmanager_secret_version" "module_url" {
  for_each      = var.module_users
  secret_id     = aws_secretsmanager_secret.module_url[each.key].id
  secret_string = replace(aws_mq_broker.this.instances[0].endpoints[0], "amqps://", "amqps://${each.key}:${urlencode(random_password.module[each.key].result)}@")
}

# Amazon MQ creates one RabbitMQ user, the administrator; the module users are created
# through the management API by `infra/scripts/broker-definitions.mjs --apply`, which reads
# this secret on its standard input. No task may read it.
resource "aws_secretsmanager_secret" "bootstrap" {
  name                    = "${var.name}/amqp-bootstrap"
  recovery_window_in_days = 7
  tags                    = var.tags
}

resource "aws_secretsmanager_secret_version" "bootstrap" {
  secret_id = aws_secretsmanager_secret.bootstrap.id
  secret_string = jsonencode(merge(
    { RABBITMQ_ADMIN_USER = "horizon", RABBITMQ_ADMIN_PASSWORD = random_password.password.result },
    {
      for module in var.module_users :
      "HORIZON_RABBITMQ_PASSWORD_${upper(replace(module, "-", "_"))}" => random_password.module[module].result
    },
  ))
}

output "security_group_id" { value = aws_security_group.this.id }
output "module_url_secret_arns" {
  value = { for module, secret in aws_secretsmanager_secret.module_url : module => secret.arn }
}
output "bootstrap_secret_arn" { value = aws_secretsmanager_secret.bootstrap.arn }
output "console_url" { value = aws_mq_broker.this.instances[0].console_url }
