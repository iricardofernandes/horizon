output "application_url" { value = var.certificate_arn == null ? "http://${module.alb.dns_name}" : "https://${module.alb.dns_name}" }
output "ecr_repository_urls" { value = module.ecr.repository_urls }
output "ecs_cluster_arn" { value = aws_ecs_cluster.this.arn }
output "database_endpoints" {
  value     = module.rds.endpoints
  sensitive = true
}
output "mq_console_url" { value = module.mq.console_url }
