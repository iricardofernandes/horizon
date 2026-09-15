bucket         = "replace-with-horizon-terraform-state"
key            = "horizon/prod/terraform.tfstate"
region         = "us-east-1"
encrypt        = true
dynamodb_table = "replace-with-horizon-terraform-locks"
