import { pool } from '../src/db.js';
import { reportSql } from '../src/repositories/reports.js';
try {
  for (const [name, sql, params] of [
    ['delivered revenue', reportSql.revenue, [null, null]],
    ['top products', reportSql.top_products, [null, null, 10]],
    [
      'customer order listing',
      'SELECT * FROM orders WHERE user_id=$1 ORDER BY created_at DESC,id LIMIT 20',
      [
        (await pool.query("SELECT id FROM users WHERE role='customer' LIMIT 1")).rows[0]?.id ??
          null,
      ],
    ],
  ]) {
    console.log(`\n${name}`);
    const result = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`, params);
    console.log(result.rows.map((row) => row['QUERY PLAN']).join('\n'));
  }
} finally {
  await pool.end();
}
