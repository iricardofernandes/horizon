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
    condition     = length(module.ecr.repository_urls) == 7
    error_message = "All seven deployable containers need immutable ECR repositories."
  }

  assert {
    condition     = length(module.rds.endpoints) == 5
    error_message = "Database-per-module requires five independent RDS instances."
  }

  assert {
    condition     = length(module.service) == 5
    error_message = "The root stack must instantiate all five business services."
  }
}
