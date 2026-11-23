import pg from "pg";

const connectionString = "postgres://mezzala:bcd2b1d73963903fe85f19077c94d0cd@localhost:5442/mezzala_gclub";
const pool = new pg.Pool({ connectionString });

async function inspect() {
  console.log("=== 1. CHECKING FOR NULLABLE club_id COLUMNS ===");
  const nullableRes = await pool.query(`
    SELECT table_name, column_name, is_nullable
    FROM information_schema.columns
    WHERE column_name = 'club_id' AND table_schema = 'public'
    ORDER BY table_name;
  `);
  console.table(nullableRes.rows);
  const nullableTables = nullableRes.rows.filter(r => r.is_nullable === "YES");
  console.log("Nullable club_id tables count:", nullableTables.length);
  if (nullableTables.length > 0) {
    console.log("Nullable tables:", nullableTables.map(t => t.table_name));
  }

  console.log("\n=== 2. CHECKING mz_rls_report ===");
  const rlsReport = await pool.query(`
    SELECT table_name, has_club_id, rls_enabled, rls_forced, status, exempt_reason
    FROM mz_rls_report
    ORDER BY status, table_name;
  `);
  console.table(rlsReport.rows);

  console.log("\n=== 3. CHECKING APPEND-ONLY TABLES (pg_trigger with mz_append_only) ===");
  const aoRes = await pool.query(`
    SELECT DISTINCT tgrelid::regclass::text AS table_name
    FROM pg_trigger
    WHERE NOT tgisinternal AND tgfoid = to_regproc('mz_append_only')
    ORDER BY table_name;
  `);
  console.table(aoRes.rows);

  await pool.end();
}

inspect().catch(err => {
  console.error("Inspection failed:", err);
  process.exit(1);
});
