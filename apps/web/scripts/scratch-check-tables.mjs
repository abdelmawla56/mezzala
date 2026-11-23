import pg from "pg";
const pool = new pg.Pool({ connectionString: "postgres://mezzala:bcd2b1d73963903fe85f19077c94d0cd@localhost:5442/mezzala_gclub" });

async function check() {
  const { rows: okTables } = await pool.query(
    "SELECT table_name FROM mz_rls_report WHERE status = 'ok' ORDER BY table_name"
  );
  
  const results = [];
  for (const { table_name } of okTables) {
    const { rows: priv } = await pool.query(
      "SELECT has_table_privilege('mz_app', $1, 'INSERT') as can_insert",
      [`public.${table_name}`]
    );
    const { rows: cols } = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default 
       FROM information_schema.columns 
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [table_name]
    );
    results.push({
      table_name,
      can_insert: priv[0].can_insert,
      columns: cols.map(c => `${c.column_name} (${c.data_type}${c.is_nullable === 'NO' ? ' NOT NULL' : ''}${c.column_default ? ' def' : ''})`)
    });
  }
  console.log(JSON.stringify(results, null, 2));
  await pool.end();
}
check();
