variable "name" { type = string }
variable "cluster_arn" { type = string }
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }
variable "image" { type = string }
variable "container_port" { type = number }
variable "cpu" { type = number }
variable "memory" { type = number }
variable "desired_count" { type = number }
variable "log_group_name" { type = string }
variable "aws_region" { type = string }
variable "ingress_security_group_ids" { type = list(string) }
variable "additional_security_group_ids" {
  type    = list(string)
  default = []
}
variable "target_group_arn" {
  type    = string
  default = null
}
variable "attach_to_load_balancer" {
  type    = bool
  default = false
}
variable "namespace_id" {
  type = string
}
variable "discovery_name" {
  type    = string
  default = null
}
variable "environment" {
  type    = map(string)
  default = {}
}
variable "secrets" {
  type    = map(string)
  default = {}
}
variable "enable_execute_command" {
  type    = bool
  default = false
}
variable "readonly_root_filesystem" {
  type    = bool
  default = true
}
variable "tags" {
  type    = map(string)
  default = {}
}

resource "aws_security_group" "this" {
  name_prefix = "${var.name}-ecs-"
  description = "Ingress to ${var.name} ECS tasks"
  vpc_id      = var.vpc_id
  dynamic "ingress" {
    for_each = toset(var.ingress_security_group_ids)
    content {
      from_port       = var.container_port
      to_port         = var.container_port
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
  tags = merge(var.tags, { Name = var.name })
}

resource "aws_iam_role" "execution" {
  name_prefix = "${var.name}-execution-"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "secret_access" {
  count = length(var.secrets) == 0 ? 0 : 1
  name  = "secret-access"
  role  = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = values(var.secrets)
    }]
  })
}

resource "aws_iam_role" "task" {
  name_prefix = "${var.name}-task-"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
  tags = var.tags
}

resource "aws_iam_role_policy" "telemetry" {
  name = "telemetry-and-exec"
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "xray:PutTraceSegments",
        "xray:PutTelemetryRecords",
        "cloudwatch:PutMetricData",
        "ssmmessages:CreateControlChannel",
        "ssmmessages:CreateDataChannel",
        "ssmmessages:OpenControlChannel",
        "ssmmessages:OpenDataChannel",
      ]
      Resource = "*"
    }]
  })
}

resource "aws_service_discovery_service" "this" {
  name = coalesce(var.discovery_name, var.name)
  dns_config {
    namespace_id   = var.namespace_id
    routing_policy = "MULTIVALUE"
    dns_records {
      ttl  = 10
      type = "A"
    }
  }
  tags = var.tags
}

resource "aws_ecs_task_definition" "this" {
  family                   = var.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([
    {
      name      = var.name
      image     = var.image
      essential = true
      portMappings = [{
        name          = "http"
        containerPort = var.container_port
        hostPort      = var.container_port
        protocol      = "tcp"
      }]
      environment = [for key, value in merge(var.environment, {
        OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318"
        OTEL_SERVICE_NAME           = var.name
      }) : { name = key, value = value }]
      secrets                = [for key, arn in var.secrets : { name = key, valueFrom = arn }]
      readonlyRootFilesystem = var.readonly_root_filesystem
      linuxParameters = {
        initProcessEnabled = true
        tmpfs              = [{ containerPath = "/tmp", size = 64, mountOptions = ["rw", "noexec", "nosuid"] }]
      }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = var.log_group_name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = var.name
        }
      }
    },
    {
      name                   = "adot-collector"
      image                  = "public.ecr.aws/aws-observability/aws-otel-collector:v0.43.3"
      essential              = false
      command                = ["--config=/etc/ecs/ecs-default-config.yaml"]
      readonlyRootFilesystem = false
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = var.log_group_name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "adot"
        }
      }
    },
  ])
  tags = var.tags
}

resource "aws_ecs_service" "this" {
  name                   = var.name
  cluster                = var.cluster_arn
  task_definition        = aws_ecs_task_definition.this.arn
  desired_count          = var.desired_count
  launch_type            = "FARGATE"
  enable_execute_command = var.enable_execute_command
  wait_for_steady_state  = false
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = concat([aws_security_group.this.id], var.additional_security_group_ids)
    assign_public_ip = false
  }
  dynamic "load_balancer" {
    for_each = var.attach_to_load_balancer ? [var.target_group_arn] : []
    content {
      target_group_arn = load_balancer.value
      container_name   = var.name
      container_port   = var.container_port
    }
  }
  service_registries {
    registry_arn   = aws_service_discovery_service.this.arn
    container_name = var.name
    container_port = var.container_port
  }
  tags = var.tags
}

output "security_group_id" { value = aws_security_group.this.id }
output "service_arn" { value = aws_ecs_service.this.id }
output "task_definition_arn" { value = aws_ecs_task_definition.this.arn }
