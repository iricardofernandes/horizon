variable "name_prefix" { type = string }
variable "data_class" { type = string }
variable "reader_writer_role_names" {
  description = "Task roles that may read and write objects, keyed by a stable name."
  type        = map(string)
}
variable "allow_delete" {
  description = "Whether those roles may also delete objects (shredding, export retention)."
  type        = bool
  default     = false
}
variable "tags" {
  type    = map(string)
  default = {}
}

resource "aws_s3_bucket" "this" {
  bucket_prefix = "${var.name_prefix}-"
  force_destroy = false
  tags          = merge(var.tags, { DataClass = var.data_class })
}

resource "aws_s3_bucket_public_access_block" "this" {
  bucket                  = aws_s3_bucket.this.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_iam_role_policy" "access" {
  for_each = var.reader_writer_role_names

  name = "${var.data_class}-objects"
  role = each.value
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = concat(
        ["s3:GetObject", "s3:PutObject"],
        var.allow_delete ? ["s3:DeleteObject"] : [],
      )
      Resource = "${aws_s3_bucket.this.arn}/*"
    }]
  })
}

output "bucket" { value = aws_s3_bucket.this.bucket }
output "arn" { value = aws_s3_bucket.this.arn }
