// apps/web/lib/media/jobs.ts
// Enqueue and query media processing jobs (probe, hash, proxy, thumbnails).
// All writes run as mz_app inside withTenant() so RLS scopes them to the caller's club.
import pool from "../db.ts";
import { withTenant } from "../db/with-tenant.ts";

export type JobKind = "probe" | "hash" | "proxy" | "thumbnails";

export interface JobPayload {
  key: string;
  expected_sha256?: string;
  height?: number;
  interval_s?: number;
  duration_ms?: number;
}

export interface MediaJob {
  id: string;
  club_id: string;
  kind: JobKind;
  asset_ref: string;
  payload: JobPayload;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  attempts: number;
  max_attempts: number;
  run_after: Date;
  last_error: string | null;
  result: Record<string, unknown> | null;
  idempotency_key: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

const VALID_KINDS: ReadonlySet<JobKind> = new Set(["probe", "hash", "proxy", "thumbnails"]);

/**
 * Enqueue a media job.  Idempotent: if a job for (club, idempotencyKey) already
 * exists it is returned unchanged (ON CONFLICT DO NOTHING + SELECT).
 */
export async function enqueue(
  club: string,
  kind: JobKind,
  assetRef: string,
  payload: JobPayload,
  idempotencyKey?: string
): Promise<MediaJob> {
  if (!VALID_KINDS.has(kind)) {
    throw new Error(`media/jobs: unknown kind "${kind}"`);
  }
  if (!payload.key) {
    throw new Error("media/jobs: payload.key is required");
  }

  const idemKey = idempotencyKey || `${kind}:${payload.key}`;

  return withTenant(pool, club, async (c) => {
    const { rows } = await c.query<MediaJob>(
      `INSERT INTO media_job
         (club_id, kind, asset_ref, payload, idempotency_key, created_by)
       VALUES ($1, $2, $3, $4, $5, 'web')
       ON CONFLICT (club_id, idempotency_key) WHERE idempotency_key IS NOT NULL
       DO UPDATE SET club_id = EXCLUDED.club_id
       RETURNING *`,
      [club, kind, assetRef, JSON.stringify(payload), idemKey]
    );
    if (!rows[0]) throw new Error("media/jobs: insert/fetch failed");
    return rows[0];
  });
}

/** Fetch a single job by id (scoped to the caller's club via RLS). */
export async function getJob(club: string, jobId: string | number): Promise<MediaJob | null> {
  return withTenant(pool, club, async (c) => {
    const { rows } = await c.query<MediaJob>(
      `SELECT * FROM media_job WHERE id = $1 AND club_id = $2`,
      [jobId, club]
    );
    return rows[0] ?? null;
  });
}

/** List all jobs for a given asset_ref, newest first. */
export async function listJobs(
  club: string,
  assetRef: string
): Promise<MediaJob[]> {
  return withTenant(pool, club, async (c) => {
    const { rows } = await c.query<MediaJob>(
      `SELECT * FROM media_job
        WHERE club_id = $1 AND asset_ref = $2
        ORDER BY id DESC`,
      [club, assetRef]
    );
    return rows;
  });
}
