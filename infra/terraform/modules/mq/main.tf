variable "name" { type = string }
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }
variable "allowed_security_group_ids" { type = list(string) }
variable "instance_type" { type = string }
variable "deployment_mode" { type = string }
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

resource "aws_secretsmanager_secret" "url" {
  name                    = "${var.name}/amqp-url"
  recovery_window_in_days = 7
  tags                    = var.tags
}

resource "aws_secretsmanager_secret_version" "url" {
  secret_id     = aws_secretsmanager_secret.url.id
  secret_string = replace(aws_mq_broker.this.instances[0].endpoints[0], "amqps://", "amqps://horizon:${urlencode(random_password.password.result)}@")
}

output "security_group_id" { value = aws_security_group.this.id }
output "url_secret_arn" {
  value = aws_secretsmanager_secret.url.arn
}
output "console_url" { value = aws_mq_broker.this.instances[0].console_url }
