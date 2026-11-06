import { createHash } from 'node:crypto';
import { transaction } from '../db.js';
import { AppError, requireFound } from '../errors.js';
import { get, authorize } from '../repositories/orders.js';
export const transitions = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
};
export async function create(items, user, idempotencyKey) {
  return transaction(async (db) => {
    const sorted = items
      .map((i) => ({ product_id: i.product_id.toLowerCase(), quantity: i.quantity }))
      .sort((a, b) => a.product_id.localeCompare(b.product_id));
    const requestHash = idempotencyKey
      ? createHash('sha256').update(JSON.stringify(sorted)).digest('hex')
      : null;
    if (idempotencyKey) {
      // Transaction-scoped and database-wide: retries serialize across API processes.
      // Hash collisions only cause extra waiting; identity still uses exact user/key SQL.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `${user.id}:${idempotencyKey}`,
      ]);
      const previous = (
        await db.query(
          'SELECT id,request_hash FROM orders WHERE user_id=$1 AND idempotency_key=$2',
          [user.id, idempotencyKey],
        )
      ).rows[0];
      if (previous) {
        if (previous.request_hash !== requestHash)
          throw new AppError(
            409,
            'Idempotency key was used for a different order',
            'IDEMPOTENCY_CONFLICT',
          );
        return get(previous.id, user, db);
      }
    }
    // Every stock-writing workflow locks products in ascending UUID order.
    const products = (
      await db.query(
        'SELECT p.*,c.active AS category_active FROM products p JOIN categories c ON c.id=p.category_id WHERE p.id=ANY($1::uuid[]) ORDER BY p.id FOR UPDATE OF p',
        [sorted.map((i) => i.product_id)],
      )
    ).rows;
    if (products.length !== sorted.length)
      throw new AppError(404, 'One or more products do not exist', 'NOT_FOUND');
    let total = 0;
    for (const item of sorted) {
      const p = products.find((p) => p.id === item.product_id);
      if (!p.active || !p.category_active || p.stock < item.quantity)
        throw new AppError(409, 'Product unavailable or insufficient stock', 'STOCK_CONFLICT');
      total += p.price_cents * item.quantity;
    }
    const order = (
      await db.query(
        "INSERT INTO orders(user_id,total_cents,idempotency_key,request_hash,history) VALUES($1::uuid,$2,$3,$4,jsonb_build_array(jsonb_build_object('status','PENDING','at',now(),'actor_id',($1::uuid)::text))) RETURNING *",
        [user.id, total, idempotencyKey ?? null, requestHash],
      )
    ).rows[0];
    for (const item of sorted) {
      const p = products.find((p) => p.id === item.product_id);
      await db.query('UPDATE products SET stock=stock-$1 WHERE id=$2', [item.quantity, p.id]);
      await db.query(
        'INSERT INTO order_items(order_id,product_id,product_name,quantity,unit_price_cents) VALUES($1,$2,$3,$4,$5)',
        [order.id, p.id, p.name, item.quantity, p.price_cents],
      );
      await db.query(
        "INSERT INTO inventory_movements(product_id,order_id,actor_id,quantity,reason) VALUES($1,$2,$3,$4,'SALE')",
        [p.id, order.id, user.id, -item.quantity],
      );
    }
    return get(order.id, user, db);
  });
}
export async function changeStatus(id, next, user) {
  return transaction(async (db) => {
    const order = requireFound(
      (await db.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id])).rows[0],
      'Order not found',
    );
    authorize(order, user);
    if (user.role !== 'admin' && next !== 'CANCELLED')
      throw new AppError(403, 'Admin access required', 'FORBIDDEN');
    if (!transitions[order.status].includes(next))
      throw new AppError(409, `Cannot transition ${order.status} to ${next}`, 'INVALID_TRANSITION');
    if (next === 'CANCELLED') {
      const items = (
        await db.query('SELECT * FROM order_items WHERE order_id=$1 ORDER BY product_id', [id])
      ).rows;
      await db.query('SELECT id FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [
        items.map((i) => i.product_id),
      ]);
      for (const item of items) {
        const updated = await db.query(
          'UPDATE products SET stock=stock+$1 WHERE id=$2 AND stock+$1<=1000000 RETURNING id',
          [item.quantity, item.product_id],
        );
        if (!updated.rowCount)
          throw new AppError(
            409,
            'Stock capacity exceeded; adjust inventory before cancellation',
            'STOCK_CONFLICT',
          );
        await db.query(
          "INSERT INTO inventory_movements(product_id,order_id,actor_id,quantity,reason) VALUES($1,$2,$3,$4,'CANCELLATION')",
          [item.product_id, id, user.id, item.quantity],
        );
      }
    }
    await db.query(
      "UPDATE orders SET status=$1,updated_at=now(),delivered_at=CASE WHEN $1='DELIVERED' THEN statement_timestamp() ELSE delivered_at END,history=history||jsonb_build_array(jsonb_build_object('status',$1::text,'at',now(),'actor_id',$3::text)) WHERE id=$2",
      [next, id, user.id],
    );
    return get(id, user, db);
  });
}
