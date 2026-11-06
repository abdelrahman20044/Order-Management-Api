import { randomBytes, createHash, randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { pool, transaction } from '../db.js';
import * as users from '../repositories/users.js';
import { AppError } from '../errors.js';
export const hashToken = (t) => createHash('sha256').update(t).digest('hex');
const invalid = () => new AppError(401, 'Invalid or expired credentials', 'UNAUTHORIZED');
// A fixed cost-equivalent hash reduces obvious unknown-account timing differences.
const dummyHash = await bcrypt.hash(randomBytes(32).toString('hex'), 12);
const accessToken = (user) =>
  jwt.sign({}, config.JWT_SECRET, {
    subject: user.id,
    expiresIn: '15m',
    issuer: 'orders-api',
    audience: 'orders-client',
    algorithm: 'HS256',
  });
async function issue(db, user, family = randomUUID()) {
  const refresh = randomBytes(48).toString('base64url');
  await db.query(
    "INSERT INTO refresh_tokens(user_id,token_hash,family_id,expires_at) VALUES($1,$2,$3,now()+interval '7 days')",
    [user.id, hashToken(refresh), family],
  );
  return { user, accessToken: accessToken(user), refresh };
}
export async function register(input) {
  const passwordHash = await bcrypt.hash(input.password, 12);
  return users.insert({ ...input, passwordHash });
}
export async function login({ email, password }) {
  const user = await users.byEmail(email);
  const valid = await bcrypt.compare(password, user?.password_hash ?? dummyHash);
  if (!user || !valid) throw invalid();
  return issue(pool, await users.publicUser(user.id));
}
export async function rotate(token) {
  if (!token) throw invalid();
  const result = await transaction(async (db) => {
    const row = (
      await db.query('SELECT * FROM refresh_tokens WHERE token_hash=$1 FOR UPDATE', [
        hashToken(token),
      ])
    ).rows[0];
    if (!row) return null;
    if (row.revoked_at || row.expires_at <= new Date()) {
      await db.query(
        'UPDATE refresh_tokens SET revoked_at=coalesce(revoked_at,now()) WHERE family_id=$1',
        [row.family_id],
      );
      return null; // Commit family revocation before rejecting replay.
    }
    await db.query('UPDATE refresh_tokens SET revoked_at=now() WHERE id=$1', [row.id]);
    return issue(db, await users.publicUser(row.user_id, db), row.family_id);
  });
  if (!result) throw invalid();
  return result;
}
export async function logout(token) {
  if (token)
    await pool.query(
      'UPDATE refresh_tokens SET revoked_at=coalesce(revoked_at,now()) WHERE family_id=(SELECT family_id FROM refresh_tokens WHERE token_hash=$1)',
      [hashToken(token)],
    );
}
