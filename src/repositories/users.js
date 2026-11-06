import { pool } from '../db.js';
export async function byEmail(email) {
  return (await pool.query('SELECT * FROM users WHERE email=$1', [email])).rows[0];
}
export async function publicUser(id, db = pool) {
  return (await db.query('SELECT id,name,email,role FROM users WHERE id=$1', [id])).rows[0];
}
export async function insert({ name, email, passwordHash }) {
  return (
    await pool.query(
      'INSERT INTO users(name,email,password_hash) VALUES($1,$2,$3) RETURNING id,name,email,role',
      [name, email, passwordHash],
    )
  ).rows[0];
}
