import { readFile, readdir } from 'node:fs/promises';
import { pool, transaction } from '../src/db.js';
try {
  await transaction(async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(1729041)');
    await db.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const name of (await readdir(new URL('../db/migrations/', import.meta.url)))
      .filter((n) => n.endsWith('.sql'))
      .sort()) {
      if ((await db.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name])).rowCount)
        continue;
      await db.query(await readFile(new URL(`../db/migrations/${name}`, import.meta.url), 'utf8'));
      await db.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
      console.log(`Applied ${name}`);
    }
  });
} finally {
  await pool.end();
}
