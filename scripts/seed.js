import bcrypt from 'bcrypt';
import { pool, transaction } from '../src/db.js';
import { config } from '../src/config.js';
import { create, changeStatus } from '../src/services/orders.js';
if (config.NODE_ENV === 'production') throw new Error('Development seed is disabled in production');
const password = process.env.SEED_PASSWORD;
if (!password || password.length < 12 || Buffer.byteLength(password) > 72)
  throw new Error('Set SEED_PASSWORD (12–72 UTF-8 bytes)');
try {
  const seeded = await transaction(async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(1729042)');
    // Skip rather than overwriting user data on subsequent runs.
    if ((await db.query('SELECT 1 FROM users LIMIT 1')).rowCount) return null;
    const hash = await bcrypt.hash(password, 12);
    const users = (
      await db.query(
        "INSERT INTO users(name,email,password_hash,role) VALUES('Store Admin','admin@example.com',$1,'admin'),('Maya Hassan','maya@example.com',$1,'customer'),('Omar Ali','omar@example.com',$1,'customer') RETURNING id,role",
        [hash],
      )
    ).rows;
    const categories = (
      await db.query(
        "INSERT INTO categories(name) VALUES('Electronics'),('Office'),('Home') RETURNING id",
      )
    ).rows;
    const products = [];
    for (const [i, name, price, stock] of [
      [0, 'USB-C Dock', 7900, 30],
      [0, 'Wireless Mouse', 2500, 50],
      [1, 'Notebook Set', 1200, 80],
      [1, 'Desk Lamp', 3900, 20],
      [2, 'Insulated Bottle', 2200, 8],
    ]) {
      const p = (
        await db.query(
          'INSERT INTO products(category_id,name,description,price_cents,stock) VALUES($1,$2,$3,$4,$5) RETURNING *',
          [categories[i].id, name, `Quality ${name.toLowerCase()} for everyday use`, price, stock],
        )
      ).rows[0];
      products.push(p);
      await db.query(
        "INSERT INTO inventory_movements(product_id,actor_id,quantity,reason) VALUES($1,$2,$3,'ADJUSTMENT')",
        [p.id, users[0].id, stock],
      );
    }
    return { users, products };
  });
  if (seeded) {
    const { users, products } = seeded;
    for (let i = 0; i < 4; i++) {
      const o = await create([{ product_id: products[i].id, quantity: i + 1 }], users[1 + (i % 2)]);
      if (i < 2)
        for (const state of ['CONFIRMED', 'SHIPPED', 'DELIVERED'])
          await changeStatus(o.id, state, users[0]);
      if (i === 2) await changeStatus(o.id, 'CANCELLED', users[0]);
    }
    console.log('Seeded 3 users, 3 categories, 5 products and 4 orders.');
  } else console.log('Seed skipped: users already exist.');
} finally {
  await pool.end();
}
