# AWS (eu-central-1 / Frankfurt) media storage, keys, logs, alarms

**Do not `terraform apply` yet.** The pack blocks any hosted video until DEC-017 (Frankfurt) is signed, counsel clears the
Egypt cross-border transfer, and the media ADR (proxy, presigned URLs, no HLS) exists (TG-ENG-30 / F-01..F-08).
This was syntax-checked only (HCL parse). It was NOT run through `terraform validate` or `plan`: do that first, in a sandbox account.

What it creates: private versioned S3 bucket (TLS-only, public access blocked, SSE-KMS default), one KMS key per tenant,
a bucket policy that rejects an object written under `<tenant>/` with another tenant's key, CORS for browser multipart upload,
two IAM *policies* (app, worker) to attach to whatever compute role you choose, a CloudWatch log group, and alarms for worker
queue lag and (optionally) ALB 5xx. Compute (where the app and worker run) is intentionally not decided here.
