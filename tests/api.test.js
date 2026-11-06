import { beforeAll, beforeEach, afterAll, describe, test, expect } from '@jest/globals';
import request from 'supertest';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { app } from '../src/app.js';
import { pool } from '../src/db.js';
import { config } from '../src/config.js';
// Destructive fixture reset must never target a normal application database.
if (config.NODE_ENV !== 'test' || !new URL(config.DATABASE_URL).pathname.endsWith('_test'))
  throw new Error('Tests require NODE_ENV=test and a database name ending in _test');
const ids = { admin: randomUUID(), customer: randomUUID(), other: randomUUID() };
const password = 'Test-only-password123!';
let hash, category, product, second;
const token = (role) =>
  jwt.sign({}, config.JWT_SECRET, {
    subject: ids[role],
    issuer: 'orders-api',
    audience: 'orders-client',
    expiresIn: '15m',
    algorithm: 'HS256',
  });
const api = (method, path, role = 'customer') => {
  const agent = request(app);
  return agent[method](`/api${path}`).set('Authorization', `Bearer ${token(role)}`);
};
const buy = (quantity = 1, p = product) =>
  api('post', '/orders').send({ items: [{ product_id: p.id, quantity }] });
const stock = async (id) =>
  (await pool.query('SELECT stock FROM products WHERE id=$1', [id])).rows[0].stock;
const count = async (table) =>
  (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
beforeAll(async () => {
  hash = await bcrypt.hash(password, 12);
  await pool.query('SELECT 1');
});
beforeEach(async () => {
  await pool.query(
    'TRUNCATE inventory_movements,order_items,orders,refresh_tokens,products,categories,users CASCADE',
  );
  for (const [role, id] of Object.entries(ids))
    await pool.query('INSERT INTO users(id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5)', [
      id,
      role,
      `${role}@example.com`,
      hash,
      role === 'admin' ? 'admin' : 'customer',
    ]);
  category = (await pool.query("INSERT INTO categories(name) VALUES('Electronics') RETURNING *"))
    .rows[0];
  product = (
    await pool.query(
      "INSERT INTO products(category_id,name,price_cents,stock) VALUES($1,'Mouse',2500,5) RETURNING *",
      [category.id],
    )
  ).rows[0];
  second = (
    await pool.query(
      "INSERT INTO products(category_id,name,price_cents,stock) VALUES($1,'Keyboard',6500,4) RETURNING *",
      [category.id],
    )
  ).rows[0];
});
afterAll(async () => {
  await pool.end();
});
describe('authentication and permissions', () => {
  test('registers without privilege escalation or exposing hashes', async () => {
    const r = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Maya', email: 'MAYA@example.com', password });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ role: 'customer', email: 'maya@example.com' });
    expect(r.body.password_hash).toBeUndefined();
    expect(
      (
        await request(app)
          .post('/api/auth/register')
          .send({ name: 'Bad', email: 'bad@example.com', password, role: 'admin' })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/api/auth/register')
          .send({ name: 'Maya', email: 'maya@example.com', password })
      ).status,
    ).toBe(409);
  });
  test('logs in, rotates, detects replay and revokes the family', async () => {
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'customer@example.com', password });
    expect(login.status).toBe(200);
    expect(login.body.refresh).toBeUndefined();
    expect(login.body.user.password_hash).toBeUndefined();
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    expect(login.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(login.headers['set-cookie'][0]).toContain('SameSite=Strict');
    const row = (await pool.query('SELECT token_hash FROM refresh_tokens')).rows[0];
    expect(row.token_hash).toHaveLength(64);
    expect(cookie).not.toContain(row.token_hash);
    expect(
      (
        await request(app)
          .get('/api/auth/me')
          .set('Authorization', `Bearer ${login.body.accessToken}`)
      ).status,
    ).toBe(200);
    const rotated = await request(app).post('/api/auth/refresh').set('Cookie', cookie);
    expect(rotated.status).toBe(200);
    const next = rotated.headers['set-cookie'][0].split(';')[0];
    expect(next).not.toBe(cookie);
    expect((await request(app).post('/api/auth/refresh').set('Cookie', cookie)).status).toBe(401);
    expect((await request(app).post('/api/auth/refresh').set('Cookie', next)).status).toBe(401);
  });
  test('rejects bad credentials, expired refresh and disallowed origins; logout revokes', async () => {
    expect(
      (
        await request(app)
          .post('/api/auth/login')
          .send({ email: 'customer@example.com', password: 'wrong-password' })
      ).status,
    ).toBe(401);
    expect((await request(app).post('/api/auth/refresh')).status).toBe(401);
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'customer@example.com', password });
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    expect(
      (
        await request(app)
          .post('/api/auth/refresh')
          .set('Cookie', cookie)
          .set('Origin', 'https://evil.example')
      ).status,
    ).toBe(403);
    expect((await request(app).post('/api/auth/logout').set('Cookie', cookie)).status).toBe(204);
    expect((await request(app).post('/api/auth/refresh').set('Cookie', cookie)).status).toBe(401);
    const again = await request(app)
      .post('/api/auth/login')
      .send({ email: 'customer@example.com', password });
    await pool.query("UPDATE refresh_tokens SET expires_at=now()-interval '1 second'");
    expect(
      (
        await request(app)
          .post('/api/auth/refresh')
          .set('Cookie', again.headers['set-cookie'][0].split(';')[0])
      ).status,
    ).toBe(401);
  });
  test('requires authentication, rejects forged tokens, and restricts admin actions', async () => {
    expect((await request(app).get('/api/orders')).status).toBe(401);
    expect(
      (await request(app).get('/api/orders').set('Authorization', 'Bearer forged')).status,
    ).toBe(401);
    expect((await api('post', '/categories').send({ name: 'Home' })).status).toBe(403);
    expect((await api('get', '/reports/revenue')).status).toBe(403);
    expect(
      (await api('post', `/products/${product.id}/inventory`).send({ quantity: 1 })).status,
    ).toBe(403);
  });
});
describe('catalog, validation and inventory', () => {
  test('category CRUD and deactivation hide catalog listings', async () => {
    const c = await api('post', '/categories', 'admin').send({ name: 'Home' });
    expect(c.status).toBe(201);
    expect((await api('get', `/categories/${c.body.id}`)).body.name).toBe('Home');
    expect(
      (await api('put', `/categories/${c.body.id}`, 'admin').send({ name: 'Kitchen' })).body.name,
    ).toBe('Kitchen');
    expect((await api('delete', `/categories/${c.body.id}`, 'admin')).status).toBe(200);
    expect((await api('get', '/categories')).body.map((c) => c.name)).not.toContain('Kitchen');
    await api('delete', `/categories/${category.id}`, 'admin');
    expect((await api('get', '/products')).body.total).toBe(0);
    expect((await buy()).status).toBe(409);
  });
  test('product CRUD, parameterized search, pagination and sorting', async () => {
    const data = {
      category_id: category.id,
      name: 'Bottle',
      price_cents: 2200,
      description: 'Steel',
    };
    const p = await api('post', '/products', 'admin').send(data);
    expect(p.status).toBe(201);
    expect(p.body.stock).toBe(0);
    const result = await api(
      'get',
      `/products?category_id=${category.id}&sort=price_cents&direction=asc&limit=1`,
    );
    expect(result.body.total).toBe(3);
    expect(result.body.data[0].name).toBe('Bottle');
    expect((await api('get', '/products?q=Mouse')).body.data[0].category_name).toBe('Electronics');
    expect((await api('get', '/products?q=%27%20OR%201%3D1--')).body.total).toBe(0);
    expect((await api('get', '/products?available=true')).body.total).toBe(2);
    expect(
      (await api('put', `/products/${p.body.id}`, 'admin').send({ ...data, price_cents: 2300 }))
        .body.price_cents,
    ).toBe(2300);
    await api('delete', `/products/${p.body.id}`, 'admin');
    expect((await api('get', `/products/${p.body.id}`)).status).toBe(404);
  });
  test('rejects invalid IDs, unsupported sort, floats, excessive quantities and client prices', async () => {
    for (const url of [
      '/products?sort=stock;DROP',
      '/products?direction=sideways',
      '/products?limit=101',
      '/orders?from=tomorrow',
      '/orders?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z',
      '/products/not-uuid',
    ])
      expect((await api('get', url)).status).toBe(400);
    expect(
      (
        await api('post', '/products', 'admin').send({
          category_id: category.id,
          name: 'Bad',
          price_cents: 1.5,
        })
      ).status,
    ).toBe(400);
    for (const quantity of [0, -1, 1.5, 101]) expect((await buy(quantity)).status).toBe(400);
    expect(
      (
        await api('post', '/orders').send({
          items: [{ product_id: product.id, quantity: 1, price_cents: 1 }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api('post', '/orders').send({
          items: [
            { product_id: product.id, quantity: 1 },
            { product_id: product.id, quantity: 2 },
          ],
        })
      ).status,
    ).toBe(400);
  });
  test('adjusts stock with an audit trail and prevents negative inventory', async () => {
    expect(
      (await api('post', `/products/${product.id}/inventory`, 'admin').send({ quantity: 3 })).body
        .stock,
    ).toBe(8);
    expect(
      (await api('post', `/products/${product.id}/inventory`, 'admin').send({ quantity: -9 }))
        .status,
    ).toBe(409);
    expect(await stock(product.id)).toBe(8);
    expect(await count('inventory_movements')).toBe(1);
  });
  test('returns consistent errors, request IDs, security headers and database health', async () => {
    const r = await request(app).get('/health');
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ok');
    expect(r.headers['x-request-id']).toBeDefined();
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    const bad = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{oops');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_JSON');
    expect((await request(app).get('/missing')).status).toBe(404);
  });
});
describe('transactional orders', () => {
  test('creates multi-item order with server totals and price/name snapshots', async () => {
    const r = await api('post', '/orders').send({
      items: [
        { product_id: product.id, quantity: 2 },
        { product_id: second.id, quantity: 1 },
      ],
    });
    expect(r.status).toBe(201);
    expect(r.body.total_cents).toBe('11500');
    expect(r.body.items).toHaveLength(2);
    expect(await stock(product.id)).toBe(3);
    expect(await count('inventory_movements')).toBe(2);
    await pool.query("UPDATE products SET price_cents=9999,name='Changed' WHERE id=$1", [
      product.id,
    ]);
    const old = await api('get', `/orders/${r.body.id}`);
    expect(old.body.items.find((i) => i.product_id === product.id)).toMatchObject({
      unit_price_cents: 2500,
      product_name: 'Mouse',
    });
  });
  test('insufficient, missing and inactive products leave no partial writes', async () => {
    expect(
      (
        await api('post', '/orders').send({
          items: [
            { product_id: product.id, quantity: 1 },
            { product_id: second.id, quantity: 5 },
          ],
        })
      ).status,
    ).toBe(409);
    expect((await buy(1, { id: randomUUID() })).status).toBe(404);
    await pool.query('UPDATE products SET active=false WHERE id=$1', [product.id]);
    expect((await buy()).status).toBe(409);
    expect(await stock(product.id)).toBe(5);
    expect(await count('orders')).toBe(0);
    expect(await count('order_items')).toBe(0);
    expect(await count('inventory_movements')).toBe(0);
  });
  test('rolls back stock, order and items when a later inventory insert fails', async () => {
    await pool.query(
      "CREATE FUNCTION test_fail_sale() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.reason='SALE' THEN RAISE EXCEPTION 'injected test failure'; END IF; RETURN NEW; END $$",
    );
    await pool.query(
      'CREATE TRIGGER test_sale_failure BEFORE INSERT ON inventory_movements FOR EACH ROW EXECUTE FUNCTION test_fail_sale()',
    );
    try {
      expect(
        (
          await api('post', '/orders')
            .set('Idempotency-Key', 'late-failure')
            .send({ items: [{ product_id: product.id, quantity: 1 }] })
        ).status,
      ).toBe(500);
      expect(await stock(product.id)).toBe(5);
      expect(await count('orders')).toBe(0);
      expect(await count('order_items')).toBe(0);
      expect(await count('inventory_movements')).toBe(0);
    } finally {
      await pool.query(
        'DROP TRIGGER test_sale_failure ON inventory_movements; DROP FUNCTION test_fail_sale()',
      );
    }
    const retry = await api('post', '/orders')
      .set('Idempotency-Key', 'late-failure')
      .send({ items: [{ product_id: product.id, quantity: 1 }] });
    expect(retry.status).toBe(201);
    expect(await count('orders')).toBe(1);
    expect(await stock(product.id)).toBe(4);
  });
  test('concurrent last-unit purchases cannot oversell', async () => {
    await pool.query('UPDATE products SET stock=1 WHERE id=$1', [product.id]);
    const results = await Promise.all([buy(), buy(), buy(), buy()]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
    expect(await stock(product.id)).toBe(0);
    expect(await count('orders')).toBe(1);
    expect(await count('inventory_movements')).toBe(1);
  });
  test('opposite multi-product request ordering completes without deadlocks', async () => {
    const a = [
      { product_id: product.id, quantity: 1 },
      { product_id: second.id, quantity: 1 },
    ];
    const r = await Promise.all([
      api('post', '/orders').send({ items: a }),
      api('post', '/orders').send({ items: [...a].reverse() }),
    ]);
    expect(r.map((r) => r.status)).toEqual([201, 201]);
    expect(await stock(product.id)).toBe(3);
    expect(await stock(second.id)).toBe(2);
  });
  test('concurrent admin decrements are atomic', async () => {
    const results = await Promise.all([
      api('post', `/products/${product.id}/inventory`, 'admin').send({ quantity: -4 }),
      api('post', `/products/${product.id}/inventory`, 'admin').send({ quantity: -4 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await stock(product.id)).toBe(1);
  });
  test('concurrent cancellation restores stock exactly once', async () => {
    const order = await buy(2);
    const results = await Promise.all([
      api('post', `/orders/${order.body.id}/cancel`),
      api('post', `/orders/${order.body.id}/cancel`),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await stock(product.id)).toBe(5);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM inventory_movements WHERE reason='CANCELLATION'",
        )
      ).rows[0].n,
    ).toBe(1);
  });
  test('enforces lifecycle, cancellation boundaries and audit history', async () => {
    const o = (await buy()).body;
    expect(
      (await api('patch', `/orders/${o.id}/status`, 'admin').send({ status: 'DELIVERED' })).status,
    ).toBe(409);
    expect(
      (await api('patch', `/orders/${o.id}/status`).send({ status: 'CONFIRMED' })).status,
    ).toBe(403);
    for (const status of ['CONFIRMED', 'SHIPPED', 'DELIVERED'])
      expect((await api('patch', `/orders/${o.id}/status`, 'admin').send({ status })).status).toBe(
        200,
      );
    expect((await api('post', `/orders/${o.id}/cancel`)).status).toBe(409);
    const h = await api('get', `/orders/${o.id}/history`);
    expect(h.body.map((h) => h.status)).toEqual(['PENDING', 'CONFIRMED', 'SHIPPED', 'DELIVERED']);
    expect(h.body.every((h) => h.at && h.actor_id)).toBe(true);
  });
  test('cancels confirmed orders and preserves inventory when cancellation cannot fit', async () => {
    const o = (await buy()).body;
    await api('patch', `/orders/${o.id}/status`, 'admin').send({ status: 'CONFIRMED' });
    await pool.query('UPDATE products SET stock=1000000 WHERE id=$1', [product.id]);
    expect((await api('post', `/orders/${o.id}/cancel`)).status).toBe(409);
    expect((await api('get', `/orders/${o.id}`)).body.status).toBe('CONFIRMED');
    await pool.query('UPDATE products SET stock=4 WHERE id=$1', [product.id]);
    expect((await api('post', `/orders/${o.id}/cancel`)).status).toBe(200);
    expect(await stock(product.id)).toBe(5);
  });
  test('hides other customers orders and scopes lists by owner and dates', async () => {
    const o = (await buy()).body;
    for (const path of [`/orders/${o.id}`, `/orders/${o.id}/history`])
      expect((await api('get', path, 'other')).status).toBe(404);
    expect((await api('post', `/orders/${o.id}/cancel`, 'other')).status).toBe(404);
    expect((await api('get', '/orders', 'other')).body.total).toBe(0);
    expect((await api('get', '/orders?status=PENDING&limit=1')).body.total).toBe(1);
    expect((await api('get', '/orders?from=2099-01-01T00:00:00Z')).body.total).toBe(0);
    expect((await api('get', `/orders/${o.id}`, 'admin')).status).toBe(200);
  });
});
describe('SQL reports', () => {
  test('counts delivered revenue, product ranks, months, low stock and customers accurately', async () => {
    const a = (await buy(2)).body;
    for (const status of ['CONFIRMED', 'SHIPPED', 'DELIVERED'])
      await api('patch', `/orders/${a.id}/status`, 'admin').send({ status });
    await buy(); // Pending order must not inflate revenue.
    const report = async (name) => (await api('get', `/reports/${name}`, 'admin')).body;
    expect((await report('revenue'))[0]).toMatchObject({
      revenue_cents: '5000',
      delivered_orders: 1,
    });
    expect((await report('top-products'))[0]).toMatchObject({
      id: product.id,
      units: 2,
      revenue_cents: '5000',
      sales_rank: '1',
    });
    expect(await report('order-counts')).toEqual(
      expect.arrayContaining([
        { status: 'PENDING', count: 1 },
        { status: 'DELIVERED', count: 1 },
      ]),
    );
    expect((await report('monthly-sales'))[0]).toMatchObject({
      revenue_cents: '5000',
      orders: 1,
      change_from_previous_active_month_cents: null,
    });
    expect(await report('low-stock?threshold=2')).toHaveLength(1);
    const customers = await report('customer-history');
    expect(customers.find((c) => c.id === ids.customer)).toMatchObject({
      order_count: 2,
      lifetime_revenue_cents: '5000',
    });
    expect(customers.find((c) => c.id === ids.other).order_count).toBe(0);
    expect((await report('revenue?from=2099-01-01T00:00:00Z'))[0].revenue_cents).toBe('0');
    expect(await report(`customers/${ids.customer}/orders`)).toHaveLength(2);
  });
});
describe('report date boundaries and rate limiting', () => {
  test('groups UTC months, computes window differences and applies half-open ranges', async () => {
    const a = (await buy()).body,
      b = (await buy(2)).body;
    for (const id of [a.id, b.id])
      for (const status of ['CONFIRMED', 'SHIPPED', 'DELIVERED'])
        expect((await api('patch', `/orders/${id}/status`, 'admin').send({ status })).status).toBe(
          200,
        );
    await pool.query("UPDATE orders SET delivered_at='2025-01-01T00:00:00Z' WHERE id=$1", [a.id]);
    await pool.query("UPDATE orders SET delivered_at='2025-02-01T00:00:00Z' WHERE id=$1", [b.id]);
    const months = (await api('get', '/reports/monthly-sales', 'admin')).body;
    expect(months).toHaveLength(2);
    expect(months[1].change_from_previous_active_month_cents).toBe('2500');
    const r = await api(
      'get',
      '/reports/revenue?from=2025-01-01T00:00:00Z&to=2025-02-01T00:00:00Z',
      'admin',
    );
    expect(r.body[0]).toMatchObject({ revenue_cents: '2500', delivered_orders: 1 });
  });
  test('auth endpoints enforce a rate limit', async () => {
    let limited = false;
    for (let i = 0; i < 101; i++) {
      const r = await request(app).post('/api/auth/refresh');
      if (r.status === 429) {
        limited = true;
        break;
      }
      expect(r.status).toBe(401);
    }
    expect(limited).toBe(true);
  });
});
describe('order creation idempotency', () => {
  const send = (key, items = [{ product_id: product.id, quantity: 1 }], role = 'customer') =>
    api('post', '/orders', role).set('Idempotency-Key', key).send({ items });
  test('retries return one order without rechecking changed stock/prices; metadata stays private', async () => {
    const a = await send('retry-1');
    expect(a.status).toBe(201);
    await pool.query('UPDATE products SET stock=0,price_cents=9000 WHERE id=$1', [product.id]);
    const b = await send('retry-1');
    expect(b.status).toBe(201);
    expect(b.body).toEqual(a.body);
    expect(b.body.request_hash).toBeUndefined();
    expect(b.body.idempotency_key).toBeUndefined();
    const list = await api('get', '/orders');
    expect(list.body.data[0].request_hash).toBeUndefined();
    expect(await count('orders')).toBe(1);
    expect(await count('inventory_movements')).toBe(1);
  });
  test('concurrent identical retries create exactly one order and stock deduction', async () => {
    const r = await Promise.all(Array.from({ length: 5 }, () => send('concurrent')));
    expect(r.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(new Set(r.map((r) => r.body.id)).size).toBe(1);
    expect(await stock(product.id)).toBe(4);
    expect(await count('order_items')).toBe(1);
    expect(await count('inventory_movements')).toBe(1);
  });
  test('same key with changed quantity/products conflicts, including concurrent requests', async () => {
    const r = await Promise.all([
      send('conflict'),
      send('conflict', [{ product_id: product.id, quantity: 2 }]),
    ]);
    expect(r.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(r.find((r) => r.status === 409).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await send('conflict', [{ product_id: second.id, quantity: 1 }])).status).toBe(409);
    expect(await count('orders')).toBe(1);
  });
  test('keys are scoped to customers and distinct keys/no key create independent orders', async () => {
    const a = await send('shared'),
      b = await send('shared', undefined, 'other');
    expect(a.body.id).not.toBe(b.body.id);
    expect(b.body.user_id).toBe(ids.other);
    expect((await send('different')).status).toBe(201);
    expect((await buy()).status).toBe(201);
    expect((await buy()).status).toBe(201);
    expect(await count('orders')).toBe(5);
  });
  test('item ordering and UUID casing do not change canonical payload; cancellation is not a new purchase', async () => {
    const items = [
      { product_id: product.id, quantity: 1 },
      { product_id: second.id, quantity: 2 },
    ];
    const a = await send('canonical', items);
    const b = await send(
      'canonical',
      [...items].reverse().map((i) => ({ ...i, product_id: i.product_id.toUpperCase() })),
    );
    expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    await api('post', `/orders/${a.body.id}/cancel`);
    const c = await send('canonical', items);
    expect(c.body.status).toBe('CANCELLED');
    expect(await stock(product.id)).toBe(5);
  });
  test('failed transactions do not consume keys, and invalid keys are rejected', async () => {
    for (const key of ['', 'bad key', 'a'.repeat(129)]) expect((await send(key)).status).toBe(400);
    await pool.query('UPDATE products SET stock=0 WHERE id=$1', [product.id]);
    expect((await send('retry-failed')).status).toBe(409);
    await pool.query('UPDATE products SET stock=5 WHERE id=$1', [product.id]);
    expect((await send('retry-failed')).status).toBe(201);
    expect(await count('orders')).toBe(1);
  });
});
describe('delivery-based sales dates', () => {
  test('creation and delivery in different months use the correct event in every report', async () => {
    const o = (await buy()).body;
    expect(o.delivered_at).toBeNull();
    await pool.query("UPDATE orders SET created_at='2025-01-10T00:00:00Z' WHERE id=$1", [o.id]);
    for (const status of ['CONFIRMED', 'SHIPPED', 'DELIVERED']) {
      const r = await api('patch', `/orders/${o.id}/status`, 'admin').send({ status });
      expect(r.status).toBe(200);
      if (status === 'DELIVERED') {
        expect(r.body.delivered_at).toBeTruthy();
        expect(r.body.delivered_at_estimated).toBe(false);
      } else expect(r.body.delivered_at).toBeNull();
    }
    await pool.query("UPDATE orders SET delivered_at='2025-02-01T00:00:00Z' WHERE id=$1", [o.id]);
    const jan = 'from=2025-01-01T00:00:00Z&to=2025-02-01T00:00:00Z',
      feb = 'from=2025-02-01T00:00:00Z&to=2025-03-01T00:00:00Z';
    const report = async (name, range) =>
      (await api('get', `/reports/${name}?${range}`, 'admin')).body;
    expect((await report('revenue', jan))[0].revenue_cents).toBe('0');
    expect((await report('revenue', feb))[0].revenue_cents).toBe('2500');
    expect(await report('monthly-sales', jan)).toHaveLength(0);
    expect((await report('monthly-sales', feb))[0].revenue_cents).toBe('2500');
    expect(await report('top-products', jan)).toHaveLength(0);
    expect((await report('top-products', feb))[0].units).toBe(1);
    expect(await report('order-counts', jan)).toEqual([{ status: 'DELIVERED', count: 1 }]);
    expect(await report('order-counts', feb)).toHaveLength(0);
    const customer = (await report('customer-history', feb)).find((c) => c.id === ids.customer);
    expect(customer).toMatchObject({
      order_count: 0,
      lifetime_revenue_cents: '2500',
      last_order_at: null,
    });
    expect(
      (await report('customer-history', jan)).find((c) => c.id === ids.customer),
    ).toMatchObject({ order_count: 1, lifetime_revenue_cents: '0' });
    expect((await api('get', `/orders?${jan}`)).body.total).toBe(1);
    expect((await api('get', `/orders?${feb}`)).body.total).toBe(0);
    expect(await report(`customers/${ids.customer}/orders`, jan)).toHaveLength(1);
  });
});
