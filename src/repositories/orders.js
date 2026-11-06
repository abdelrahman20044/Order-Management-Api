import { pool } from '../db.js';
import { requireFound, AppError } from '../errors.js';
export function authorize(order, user) {
  if (user.role !== 'admin' && order.user_id !== user.id)
    throw new AppError(404, 'Order not found', 'NOT_FOUND');
}
function publicOrder({ idempotency_key: _key, request_hash: _hash, ...order }) {
  return order;
}
export async function get(id, user, db = pool) {
  const order = requireFound(
    (await db.query('SELECT * FROM orders WHERE id=$1', [id])).rows[0],
    'Order not found',
  );
  authorize(order, user);
  const items = (
    await db.query(
      'SELECT product_id,product_name,quantity,unit_price_cents FROM order_items WHERE order_id=$1 ORDER BY product_id',
      [id],
    )
  ).rows;
  return { ...publicOrder(order), items };
}
export async function list(q, user) {
  const values = [
    user.role === 'admin' ? null : user.id,
    q.status ?? null,
    q.from ?? null,
    q.to ?? null,
  ];
  const where =
    '($1::uuid IS NULL OR user_id=$1) AND ($2::text IS NULL OR status=$2) AND ($3::timestamptz IS NULL OR created_at >= $3) AND ($4::timestamptz IS NULL OR created_at < $4)';
  const total = (
    await pool.query(`SELECT count(*)::int AS count FROM orders WHERE ${where}`, values)
  ).rows[0].count;
  const data = (
    await pool.query(
      `SELECT * FROM orders WHERE ${where} ORDER BY created_at DESC,id LIMIT $5 OFFSET $6`,
      [...values, q.limit, (q.page - 1) * q.limit],
    )
  ).rows;
  return { data: data.map(publicOrder), total, page: q.page, limit: q.limit };
}
