output "bucket" {
  value = aws_s3_bucket.media.id
}

output "tenant_kms_keys" {
  description = "Paste as MZ_TENANT_KMS_KEYS (worker) and into the app's storage adapter."
  value       = { for k, v in aws_kms_key.tenant : k => v.arn }
}

output "app_policy_arn" {
  value = aws_iam_policy.app.arn
}

output "worker_policy_arn" {
  value = aws_iam_policy.worker.arn
}
