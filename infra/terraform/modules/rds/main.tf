variable "name_prefix" { type = string }
variable "database_names" { type = set(string) }
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }
variable "allowed_security_group_ids" { type = list(string) }
variable "instance_class" { type = string }
variable "allocated_storage" { type = number }
variable "multi_az" { type = bool }
variable "deletion_protection" { type = bool }
variable "backup_retention_days" { type = number }
variable "tags" {
  type    = map(string)
  default = {}
}

resource "aws_db_subnet_group" "this" {
  name       = "${var.name_prefix}-db"
  subnet_ids = var.subnet_ids
  tags       = var.tags
}

resource "aws_security_group" "this" {
  name_prefix = "${var.name_prefix}-rds-"
  description = "PostgreSQL from Horizon ECS tasks only"
  vpc_id      = var.vpc_id
  dynamic "ingress" {
    for_each = toset(var.allowed_security_group_ids)
    content {
      from_port       = 5432
      to_port         = 5432
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
  tags = merge(var.tags, { Name = "${var.name_prefix}-rds" })
}

resource "random_password" "master" {
  for_each = var.database_names
  length   = 32
  special  = false
}

resource "random_password" "application" {
  for_each = var.database_names
  length   = 32
  special  = false
}

resource "random_password" "relay" {
  for_each = var.database_names
  length   = 32
  special  = false
}

resource "aws_db_instance" "this" {
  for_each = var.database_names

  identifier                   = "${var.name_prefix}-${each.value}"
  engine                       = "postgres"
  engine_version               = "17.4"
  instance_class               = var.instance_class
  allocated_storage            = var.allocated_storage
  max_allocated_storage        = var.allocated_storage * 2
  storage_type                 = "gp3"
  storage_encrypted            = true
  db_name                      = "horizon_${each.value}"
  username                     = "horizon_owner"
  password                     = random_password.master[each.key].result
  port                         = 5432
  db_subnet_group_name         = aws_db_subnet_group.this.name
  vpc_security_group_ids       = [aws_security_group.this.id]
  publicly_accessible          = false
  multi_az                     = var.multi_az
  backup_retention_period      = var.backup_retention_days
  deletion_protection          = var.deletion_protection
  skip_final_snapshot          = !var.deletion_protection
  final_snapshot_identifier    = var.deletion_protection ? "${var.name_prefix}-${each.value}-final" : null
  performance_insights_enabled = true
  auto_minor_version_upgrade   = true
  apply_immediately            = false
  copy_tags_to_snapshot        = true
  tags                         = merge(var.tags, { Module = each.value })
}

resource "aws_secretsmanager_secret" "owner_url" {
  for_each                = var.database_names
  name                    = "${var.name_prefix}/${each.value}/owner-database-url"
  recovery_window_in_days = 7
  tags                    = var.tags
}

resource "aws_secretsmanager_secret_version" "owner_url" {
  for_each  = var.database_names
  secret_id = aws_secretsmanager_secret.owner_url[each.key].id
  secret_string = format(
    "postgres://horizon_owner:%s@%s:5432/horizon_%s",
    urlencode(random_password.master[each.key].result),
    aws_db_instance.this[each.key].address,
    each.value,
  )
}

resource "aws_secretsmanager_secret" "application_url" {
  for_each                = var.database_names
  name                    = "${var.name_prefix}/${each.value}/application-database-url"
  recovery_window_in_days = 7
  tags                    = var.tags
}

resource "aws_secretsmanager_secret_version" "application_url" {
  for_each  = var.database_names
  secret_id = aws_secretsmanager_secret.application_url[each.key].id
  secret_string = format(
    "postgres://horizon_app:%s@%s:5432/horizon_%s",
    urlencode(random_password.application[each.key].result),
    aws_db_instance.this[each.key].address,
    each.value,
  )
}

resource "aws_secretsmanager_secret" "relay_url" {
  for_each                = var.database_names
  name                    = "${var.name_prefix}/${each.value}/relay-database-url"
  recovery_window_in_days = 7
  tags                    = var.tags
}

resource "aws_secretsmanager_secret_version" "relay_url" {
  for_each  = var.database_names
  secret_id = aws_secretsmanager_secret.relay_url[each.key].id
  secret_string = format(
    "postgres://horizon_relay:%s@%s:5432/horizon_%s",
    urlencode(random_password.relay[each.key].result),
    aws_db_instance.this[each.key].address,
    each.value,
  )
}

output "security_group_id" { value = aws_security_group.this.id }
output "endpoints" { value = { for name, database in aws_db_instance.this : name => database.endpoint } }
output "owner_database_url_secret_arns" {
  value = { for name, secret in aws_secretsmanager_secret.owner_url : name => secret.arn }
}
output "application_database_url_secret_arns" {
  value = { for name, secret in aws_secretsmanager_secret.application_url : name => secret.arn }
}
output "relay_database_url_secret_arns" {
  value = { for name, secret in aws_secretsmanager_secret.relay_url : name => secret.arn }
}
output "application_passwords" {
  value     = { for name, password in random_password.application : name => password.result }
  sensitive = true
}
output "relay_passwords" {
  value     = { for name, password in random_password.relay : name => password.result }
  sensitive = true
}
