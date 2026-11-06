import { config } from '../config.js';
import * as auth from '../services/auth.js';
// Controllers own HTTP/cookie details. Services own transactions; repositories own SQL.
const cookieOptions = {
  httpOnly: true,
  secure: config.NODE_ENV === 'production',
  sameSite: 'strict',
  path: '/api/auth',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};
export const respond =
  (fn, status = 200) =>
  async (req, res) =>
    res.status(status).json(await fn(req));
function tokens(res, result) {
  res.cookie('refresh_token', result.refresh, cookieOptions);
  return res.json({
    user: result.user,
    accessToken: result.accessToken,
    tokenType: 'Bearer',
    expiresIn: 900,
  });
}
export const login = async (req, res) => tokens(res, await auth.login(req.validated.body));
export const refresh = async (req, res) => {
  try {
    return tokens(res, await auth.rotate(req.cookies.refresh_token));
  } catch (error) {
    res.clearCookie('refresh_token', cookieOptions);
    throw error;
  }
};
export const logout = async (req, res) => {
  await auth.logout(req.cookies.refresh_token);
  res.clearCookie('refresh_token', cookieOptions);
  res.status(204).end();
};
