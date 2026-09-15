variable "name" { type = string }
variable "services" { type = set(string) }
variable "log_retention_days" { type = number }
variable "alb_arn_suffix" { type = string }
variable "tags" {
  type    = map(string)
  default = {}
}

resource "aws_cloudwatch_log_group" "service" {
  for_each          = var.services
  name              = "/ecs/${var.name}/${each.value}"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_cloudwatch_dashboard" "this" {
  dashboard_name = var.name
  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title   = "ALB request rate and 5xx"
          region  = data.aws_region.current.region
          view    = "timeSeries"
          stacked = false
          metrics = [
            ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", var.alb_arn_suffix, { stat = "Sum" }],
            [".", "HTTPCode_Target_5XX_Count", ".", ".", { stat = "Sum" }],
          ]
        }
      },
      {
        type   = "log"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "Recent application errors"
          region = data.aws_region.current.region
          query  = "SOURCE ${join(" | SOURCE ", [for service in var.services : "'/ecs/${var.name}/${service}'"])} | fields @timestamp, @message | filter level = 'error' | sort @timestamp desc | limit 50"
          view   = "table"
        }
      },
    ]
  })
}

data "aws_region" "current" {}

output "log_group_names" { value = { for service, group in aws_cloudwatch_log_group.service : service => group.name } }
