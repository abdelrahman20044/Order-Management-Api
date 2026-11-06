import { test, expect, afterAll } from '@jest/globals';
import { readFile } from 'node:fs/promises';
import { pool } from '../src/db.js';
import { config } from '../src/config.js';
if (config.NODE_ENV !== 'test' || !new URL(config.DATABASE_URL).pathname.endsWith('_test'))
  throw new Error('Requires test database');
afterAll(() => pool.end());
test('forward migration preserves history, flags estimated backfills, and supports legacy orders', async () => {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('CREATE SCHEMA delivery_migration_test');
    await db.query('SET LOCAL search_path TO delivery_migration_test');
    await db.query(
      await readFile(new URL('../db/migrations/001_schema.sql', import.meta.url), 'utf8'),
    );
    const user = (
      await db.query(
        "INSERT INTO users(name,email,password_hash) VALUES('Legacy','legacy@example.com','test-only') RETURNING id",
      )
    ).rows[0];
    const insert = async (status, history) =>
      (
        await db.query(
          "INSERT INTO orders(user_id,status,total_cents,created_at,updated_at,history) VALUES($1,$2,100,'2025-01-01Z','2025-03-01Z',$3) RETURNING id",
          [user.id, status, JSON.stringify(history)],
        )
      ).rows[0].id;
    const exact = await insert('DELIVERED', [{ status: 'DELIVERED', at: '2025-02-01T00:00:00Z' }]);
    const missing = await insert('DELIVERED', [{ status: 'DELIVERED' }]);
    const invalid = await insert('DELIVERED', [{ status: 'DELIVERED', at: 'invalid' }]);
    const pending = await insert('PENDING', []);
    await db.query(
      await readFile(
        new URL('../db/migrations/002_delivery_and_idempotency.sql', import.meta.url),
        'utf8',
      ),
    );
    const rows = (await db.query('SELECT * FROM orders')).rows;
    expect(rows.find((o) => o.id === exact).delivered_at.toISOString()).toBe(
      '2025-02-01T00:00:00.000Z',
    );
    expect(rows.find((o) => o.id === exact).delivered_at_estimated).toBe(false);
    for (const id of [missing, invalid]) {
      expect(rows.find((o) => o.id === id).delivered_at.toISOString()).toBe(
        '2025-03-01T00:00:00.000Z',
      );
      expect(rows.find((o) => o.id === id).delivered_at_estimated).toBe(true);
    }
    expect(rows.find((o) => o.id === pending).delivered_at).toBeNull();
    expect(rows.every((o) => o.idempotency_key === null)).toBe(true);
    await expect(
      db.query('UPDATE orders SET delivered_at=NULL WHERE id=$1', [exact]),
    ).rejects.toMatchObject({ code: '23514' });
  } finally {
    await db.query('ROLLBACK');
    db.release();
  }
});
