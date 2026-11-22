// apps/web/lib/tagging/store.ts
// Tag store: thin wrapper around DB queries for annotation reads/writes.
// Every query runs inside withTenant().
import pool from "../db";
import { withTenant } from "../db/with-tenant";

export async function annotationsOf(clubId: string, matchId: number) {
  return withTenant(pool, clubId, async (c) => {
    const { rows } = await c.query(
      `SELECT a.id, a.pass_id, ar.rev, ar.match_ms, ar.payload, ar.created_at
         FROM annotation a
         JOIN annotation_revision ar ON ar.annotation_id = a.id
        WHERE a.match_id = $1
          AND ar.rev = (SELECT max(ar2.rev) FROM annotation_revision ar2 WHERE ar2.annotation_id = a.id)
        ORDER BY ar.match_ms`,
      [matchId]
    );
    return rows;
  });
}
