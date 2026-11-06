import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { publicUser } from '../repositories/users.js';
import { AppError } from '../errors.js';
export async function authenticate(req, _res, next) {
  const token = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
  let payload;
  try {
    payload = jwt.verify(token, config.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: 'orders-api',
      audience: 'orders-client',
    });
  } catch {
    throw new AppError(401, 'A valid access token is required', 'UNAUTHORIZED');
  }
  req.user = await publicUser(payload.sub);
  if (!req.user) throw new AppError(401, 'User no longer exists', 'UNAUTHORIZED');
  next();
}
export function admin(req, _res, next) {
  if (req.user.role !== 'admin') throw new AppError(403, 'Admin access required', 'FORBIDDEN');
  next();
}
