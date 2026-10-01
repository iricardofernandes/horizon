variable "environment" { type = string }
variable "aws_region" { type = string }
variable "vpc_cidr" { type = string }
variable "nat_gateway_per_az" { type = bool }
variable "certificate_arn" {
  type    = string
  default = null
}
variable "image_tag" { type = string }
variable "desired_count" { type = number }
variable "task_cpu" { type = number }
variable "task_memory" { type = number }
variable "rds_instance_class" { type = string }
variable "rds_allocated_storage" { type = number }
variable "rds_multi_az" { type = bool }
variable "rds_deletion_protection" { type = bool }
variable "backup_retention_days" { type = number }
variable "redis_node_type" { type = string }
variable "redis_replicas" { type = number }
variable "redis_automatic_failover" { type = bool }
variable "mq_instance_type" { type = string }
variable "mq_deployment_mode" { type = string }
variable "log_retention_days" { type = number }
variable "service_secret_arns" {
  description = "Additional runtime secrets already provisioned by the security bootstrap, keyed by service then environment variable."
  type        = map(map(string))
  default     = {}
}
variable "clamav_image" {
  description = "The ClamAV daemon image, pinned by tag or digest."
  type        = string
  default     = "clamav/clamav:1.4"
}
variable "clamav_cpu" {
  type    = number
  default = 1024
}
variable "clamav_memory" {
  description = "ClamAV holds its signatures in memory: about 1 GB loaded, twice that while reloading."
  type        = number
  default     = 3072
}
