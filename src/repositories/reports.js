import { pool } from '../db.js';
export const reportSql = {
  revenue: `SELECT coalesce(sum(total_cents),0)::text AS revenue_cents,count(*)::int AS delivered_orders FROM orders WHERE status='DELIVERED' AND ($1::timestamptz IS NULL OR created_at >= $1) AND ($2::timestamptz IS NULL OR created_at < $2)`,
  top_products: `WITH sales AS (
 SELECT p.id,p.name,sum(i.quantity)::int AS units,sum(i.quantity::bigint*i.unit_price_cents)::text AS revenue_cents
 FROM order_items i INNER JOIN orders o ON o.id=i.order_id INNER JOIN products p ON p.id=i.product_id
 WHERE o.status='DELIVERED' AND ($1::timestamptz IS NULL OR o.created_at >= $1) AND ($2::timestamptz IS NULL OR o.created_at < $2)
 GROUP BY p.id,p.name HAVING sum(i.quantity)>0
 ) SELECT *,dense_rank() OVER(ORDER BY units DESC) AS sales_rank FROM sales ORDER BY units DESC,id LIMIT $3`,
  order_counts: `SELECT status,count(*)::int AS count FROM orders WHERE ($1::timestamptz IS NULL OR created_at >= $1) AND ($2::timestamptz IS NULL OR created_at < $2) GROUP BY status ORDER BY status`,
  monthly_sales: `WITH monthly AS (
 SELECT date_trunc('month',created_at AT TIME ZONE 'UTC') AS month,sum(total_cents) AS revenue_cents,count(*)::int AS orders
 FROM orders WHERE status='DELIVERED' AND ($1::timestamptz IS NULL OR created_at >= $1) AND ($2::timestamptz IS NULL OR created_at < $2) GROUP BY 1
 ) SELECT month,revenue_cents::text,orders,(revenue_cents-lag(revenue_cents) OVER(ORDER BY month))::text AS change_from_previous_active_month_cents FROM monthly ORDER BY month`,
  low_stock: `SELECT p.id,p.name,p.stock,c.name AS category_name FROM products p JOIN categories c ON c.id=p.category_id WHERE p.active AND c.active AND p.stock <= $1 ORDER BY p.stock,p.id LIMIT $2`,
  customer_history: `SELECT u.id,u.name,count(o.id)::int AS order_count,coalesce(sum(o.total_cents) FILTER(WHERE o.status='DELIVERED'),0)::text AS lifetime_revenue_cents,max(o.created_at) AS last_order_at
 FROM users u LEFT JOIN orders o ON o.user_id=u.id AND ($1::timestamptz IS NULL OR o.created_at >= $1) AND ($2::timestamptz IS NULL OR o.created_at < $2)
 WHERE u.role='customer' GROUP BY u.id,u.name ORDER BY coalesce(sum(o.total_cents) FILTER(WHERE o.status='DELIVERED'),0) DESC,u.id LIMIT $3`,
};
export async function report(name, q) {
  const params =
    name === 'low_stock'
      ? [q.threshold, q.limit]
      : ['top_products', 'customer_history'].includes(name)
        ? [q.from ?? null, q.to ?? null, q.limit]
        : [q.from ?? null, q.to ?? null];
  return (await pool.query(reportSql[name], params)).rows;
}
export async function customerOrders(id, q) {
  return (
    await pool.query(
      'SELECT id,status,total_cents,created_at FROM orders WHERE user_id=$1 AND ($2::text IS NULL OR status=$2) AND ($3::timestamptz IS NULL OR created_at >= $3) AND ($4::timestamptz IS NULL OR created_at < $4) ORDER BY created_at DESC,id LIMIT $5 OFFSET $6',
      [id, q.status ?? null, q.from ?? null, q.to ?? null, q.limit, (q.page - 1) * q.limit],
    )
  ).rows;
}
