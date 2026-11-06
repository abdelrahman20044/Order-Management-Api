import { pool } from '../db.js';
import { requireFound } from '../errors.js';
export const categories = async () =>
  (await pool.query('SELECT * FROM categories WHERE active ORDER BY name')).rows;
export async function category(id) {
  return requireFound((await pool.query('SELECT * FROM categories WHERE id=$1', [id])).rows[0]);
}
export async function saveCategory(id, { name, active = true }) {
  return requireFound(
    (
      await pool.query(
        id
          ? 'UPDATE categories SET name=$1,active=$2 WHERE id=$3 RETURNING *'
          : 'INSERT INTO categories(name,active) VALUES($1,$2) RETURNING *',
        id ? [name, active, id] : [name, active],
      )
    ).rows[0],
  );
}
export async function deleteCategory(id) {
  requireFound(
    (await pool.query('UPDATE categories SET active=false WHERE id=$1 RETURNING id', [id])).rows[0],
  );
}
export async function products(q) {
  const values = [q.q ? `%${q.q}%` : null, q.category_id ?? null, q.available ?? null];
  const where = `p.active AND c.active AND ($1::text IS NULL OR p.name ILIKE $1 OR p.description ILIKE $1) AND ($2::uuid IS NULL OR p.category_id=$2) AND ($3::text IS NULL OR (p.stock>0)=($3='true'))`;
  const total = (
    await pool.query(
      `SELECT count(*)::int AS count FROM products p JOIN categories c ON c.id=p.category_id WHERE ${where}`,
      values,
    )
  ).rows[0].count;
  // sort and direction originate exclusively from a Zod enum, never raw client input.
  const sort = { name: 'p.name', price_cents: 'p.price_cents', created_at: 'p.created_at' }[q.sort];
  const data = (
    await pool.query(
      `SELECT p.*,c.name AS category_name FROM products p JOIN categories c ON c.id=p.category_id WHERE ${where} ORDER BY ${sort} ${q.direction === 'asc' ? 'ASC' : 'DESC'},p.id LIMIT $4 OFFSET $5`,
      [...values, q.limit, (q.page - 1) * q.limit],
    )
  ).rows;
  return { data, total, page: q.page, limit: q.limit };
}
export async function product(id) {
  return requireFound(
    (
      await pool.query(
        'SELECT p.*,c.name AS category_name FROM products p JOIN categories c ON c.id=p.category_id WHERE p.id=$1 AND p.active AND c.active',
        [id],
      )
    ).rows[0],
  );
}
export async function saveProduct(id, p) {
  const vals = [p.category_id, p.name, p.description, p.price_cents, p.active ?? true];
  return requireFound(
    (
      await pool.query(
        id
          ? 'UPDATE products SET category_id=$1,name=$2,description=$3,price_cents=$4,active=$5 WHERE id=$6 RETURNING *'
          : 'INSERT INTO products(category_id,name,description,price_cents,active) VALUES($1,$2,$3,$4,$5) RETURNING *',
        id ? [...vals, id] : vals,
      )
    ).rows[0],
  );
}
export async function deleteProduct(id) {
  requireFound(
    (await pool.query('UPDATE products SET active=false WHERE id=$1 RETURNING id', [id])).rows[0],
  );
}
