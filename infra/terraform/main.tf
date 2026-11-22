terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { project = "mezzala", env = var.env }
  }
}

locals {
  tenants = toset(var.tenants)
}

# One key per tenant: the unit you can disable or schedule for deletion for that tenant alone.
resource "aws_kms_key" "tenant" {
  for_each                = local.tenants
  description             = "MEZZALA ${var.env} media key for tenant ${each.key}"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "tenant" {
  for_each      = local.tenants
  name          = "alias/mezzala-${var.env}-${lower(each.key)}"
  target_key_id = aws_kms_key.tenant[each.key].key_id
}

# Platform key for the bucket default (objects written without an explicit tenant key still never sit unencrypted).
resource "aws_kms_key" "platform" {
  description         = "MEZZALA ${var.env} platform default key"
  enable_key_rotation = true
}

resource "aws_s3_bucket" "media" {
  bucket = var.bucket_name
}

resource "aws_s3_bucket_public_access_block" "media" {
  bucket                  = aws_s3_bucket.media.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "media" {
  bucket = aws_s3_bucket.media.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    bucket_key_enabled = true
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.platform.arn
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 3
    }
  }
}

resource "aws_s3_bucket_cors_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  cors_rule {
    allowed_methods = ["PUT", "GET", "HEAD"]
    allowed_origins = var.web_origins
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

data "aws_iam_policy_document" "bucket" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.media.arn, "${aws_s3_bucket.media.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  # An object under "<tenant>/" may only carry that tenant's key. IfExists: UploadPart carries no header.
  dynamic "statement" {
    for_each = local.tenants
    content {
      sid       = "WrongKeyFor${replace(statement.key, "-", "")}"
      effect    = "Deny"
      actions   = ["s3:PutObject"]
      resources = ["${aws_s3_bucket.media.arn}/${statement.key}/*"]
      principals {
        type        = "*"
        identifiers = ["*"]
      }
      condition {
        test     = "StringNotEqualsIfExists"
        variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
        values   = [aws_kms_key.tenant[statement.key].arn]
      }
    }
  }
}

resource "aws_s3_bucket_policy" "media" {
  bucket     = aws_s3_bucket.media.id
  policy     = data.aws_iam_policy_document.bucket.json
  depends_on = [aws_s3_bucket_public_access_block.media]
}

locals {
  tenant_key_arns = [for k in aws_kms_key.tenant : k.arn]
}

# The app presigns uploads and downloads (<= 10 min) and reads; it never deletes originals.
data "aws_iam_policy_document" "app" {
  statement {
    actions   = ["s3:PutObject", "s3:GetObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"]
    resources = ["${aws_s3_bucket.media.arn}/*"]
  }
  statement {
    actions   = ["s3:ListBucket", "s3:ListBucketMultipartUploads"]
    resources = [aws_s3_bucket.media.arn]
  }
  statement {
    actions   = ["kms:GenerateDataKey", "kms:Decrypt", "kms:DescribeKey"]
    resources = concat(local.tenant_key_arns, [aws_kms_key.platform.arn])
  }
}

# The worker reads originals and writes derivatives under <tenant>/derived/ only.
data "aws_iam_policy_document" "worker" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.media.arn}/*"]
  }
  statement {
    actions   = ["s3:PutObject", "s3:AbortMultipartUpload"]
    resources = [for t in var.tenants : "${aws_s3_bucket.media.arn}/${t}/derived/*"]
  }
  statement {
    actions   = ["kms:GenerateDataKey", "kms:Decrypt", "kms:DescribeKey"]
    resources = concat(local.tenant_key_arns, [aws_kms_key.platform.arn])
  }
}

resource "aws_iam_policy" "app" {
  name   = "mezzala-${var.env}-app-media"
  policy = data.aws_iam_policy_document.app.json
}

resource "aws_iam_policy" "worker" {
  name   = "mezzala-${var.env}-worker-media"
  policy = data.aws_iam_policy_document.worker.json
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/mezzala/${var.env}/app"
  retention_in_days = 90
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/mezzala/${var.env}/media-worker"
  retention_in_days = 90
}

# The worker prints QueueLagSeconds as an embedded-metric-format log line (namespace MEZZALA/Media).
resource "aws_cloudwatch_metric_alarm" "queue_lag" {
  alarm_name          = "mezzala-${var.env}-media-queue-lag"
  namespace           = "MEZZALA/Media"
  metric_name         = "QueueLagSeconds"
  dimensions          = { Service = "media-worker" }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  threshold           = 600
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = var.alarm_topic_arn == "" ? [] : [var.alarm_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  count               = var.alb_arn_suffix == "" ? 0 : 1
  alarm_name          = "mezzala-${var.env}-app-5xx"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  dimensions          = { LoadBalancer = var.alb_arn_suffix }
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 5
  threshold           = 5
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_topic_arn == "" ? [] : [var.alarm_topic_arn]
}
