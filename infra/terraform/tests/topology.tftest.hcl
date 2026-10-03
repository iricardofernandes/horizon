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
    condition     = length(module.ecr.repository_urls) == 19
    error_message = "All sixteen services, web, the gateway and the probe need immutable ECR repositories."
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
      module.web.environment.HORIZON_API_URL == "http://gateway.horizon.local:8000" &&
      module.web.environment.HORIZON_COOKIE_SECURE == "true" &&
      module.web.environment.HORIZON_WEB_TRUSTED_HOPS == "1"
    )
    error_message = "The web reads HORIZON_API_URL, and behind HTTPS sets Secure cookies and trusts one hop."
  }

  assert {
    condition = (
      module.gateway.environment.KONG_TRUSTED_IPS == var.vpc_cidr &&
      module.gateway.environment.KONG_REAL_IP_HEADER == "X-Forwarded-For"
    )
    error_message = "Kong believes a forwarded address only from inside the VPC."
  }

  assert {
    condition     = module.probe.environment.PROBE_BASE_URL == "http://gateway.horizon.local:8000"
    error_message = "The synthetic probe walks the golden path through the gateway."
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
