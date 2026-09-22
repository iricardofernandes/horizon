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
    condition     = length(module.ecr.repository_urls) == 8
    error_message = "All eight deployable containers need immutable ECR repositories."
  }

  assert {
    condition     = length(module.rds.endpoints) == 6
    error_message = "Database-per-module requires six independent RDS instances."
  }

  assert {
    condition     = length(module.service) == 6
    error_message = "The root stack must instantiate all six business services."
  }
}
