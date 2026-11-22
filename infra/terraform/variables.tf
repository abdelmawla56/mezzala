variable "env" {
  type    = string
  default = "dev"
}

variable "region" {
  type    = string
  default = "eu-central-1"
}

variable "bucket_name" {
  type = string
}

variable "tenants" {
  description = "Tenant ids, exactly as in tenant.id (object keys start with '<tenant>/')."
  type        = list(string)
  default     = ["GCLUB", "TEST-000"]
}

variable "web_origins" {
  description = "Origins allowed to PUT parts straight to S3 from the browser."
  type        = list(string)
}

variable "alb_arn_suffix" {
  description = "Set to enable the 5xx alarm (ALB dimension). Empty = skip."
  type        = string
  default     = ""
}

variable "alarm_topic_arn" {
  description = "SNS topic for alarm actions. Empty = alarms without actions."
  type        = string
  default     = ""
}
