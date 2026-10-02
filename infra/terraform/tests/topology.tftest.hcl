mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = {
      names = ["us-east-1a", "us-east-1b", "us-east-1c"]
    }
  }
  mock_data "aws_region" {
    defaults = {
      region = "us-east-1"
    }
  }
}

mock_provider "random" {}

run "topology_plans" {
  command = plan

  assert {
    condition     = length(module.ecr.repository_urls) == 18
    error_message = "All sixteen services, web and the gateway need immutable ECR repositories."
  }

  assert {
    condition     = length(module.rds.endpoints) == 16
    error_message = "Database-per-module requires sixteen independent RDS instances."
  }

  assert {
    condition     = length(module.service) == 16
    error_message = "The root stack must instantiate all sixteen business services."
  }

  assert {
    condition = (
      length(module.mq.module_url_secret_arns) == length(module.service) &&
      alltrue([for name in keys(module.service) : contains(keys(module.mq.module_url_secret_arns), name)])
    )
    error_message = "Each service connects to the broker as a user of its own (ADR 0075)."
  }

  assert {
    condition     = alltrue([for name in ["parties", "catalog", "identity"] : contains(keys(module.service), name)])
    error_message = "Fiscal calls Parties and Catalog directly, and every service reads Identity's JWKS."
  }
}
