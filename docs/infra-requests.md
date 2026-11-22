# Infra Change Requests

Per Ground Rule 1 ("Do not edit `infra/`. If it needs a change, stop and write the request (what, why, which file) in `docs/infra-requests.md`"):

---

### Request IR-001: Fix invalid Dockerfile instruction in `worker/Dockerfile`
- **File:** `infra/worker/Dockerfile`
- **Line:** 10
- **What:** Change `STOP_SIGNAL SIGTERM` to `STOPSIGNAL SIGTERM`.
- **Why:** `STOP_SIGNAL` is not a valid Dockerfile instruction and causes `docker build` to fail immediately with:
  ```
  ERROR: failed to build: failed to solve: dockerfile parse error on line 10: unknown instruction: STOP_SIGNAL (did you mean STOPSIGNAL?)
  ```

---

### Request IR-002: Update MinIO image tags in `docker-compose.yml`
- **File:** `infra/docker-compose.yml`
- **Lines:** 36, 45, 51
- **What:**
  1. Update `image: minio/minio:latest` and `image: minio/mc:latest` to pinned release tags (or `alpine/minio:RELEASE.2025-10-15T17-29-55Z`).
  2. Update healthcheck to `test: ["CMD-SHELL", "wget -q --spider http://127.0.0.1:9000/minio/health/live || exit 1"]` when using Alpine-based MinIO.
- **Why:** MinIO upstream removed the `:latest` tag from Docker Hub, causing `docker compose up` to fail with `pull access denied for minio/mc, repository does not exist or may require 'docker login'`.
