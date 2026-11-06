import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { AppError } from './errors.js';
import { authenticate, admin } from './middleware/auth.js';
import * as v from './validation.js';
import { respond, login, refresh, logout } from './controllers/index.js';
import * as auth from './services/auth.js';
import * as catalog from './repositories/catalog.js';
import { adjustStock } from './services/catalog.js';
import * as orders from './repositories/orders.js';
import * as orderService from './services/orders.js';
import * as reports from './repositories/reports.js';
export const routes = Router();
const body = (s) => v.validate(s),
  params = v.validate(v.idParams, 'params'),
  query = (s) => v.validate(s, 'query');
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many authentication requests' } },
});
routes.use('/auth', authLimiter, (req, _res, next) => {
  const origin = req.headers.origin;
  if (
    origin &&
    !config.CORS_ORIGINS.split(',')
      .map((s) => s.trim())
      .includes(origin)
  )
    throw new AppError(403, 'Origin not allowed', 'FORBIDDEN');
  next();
});
routes.post(
  '/auth/register',
  body(v.registerSchema),
  respond((r) => auth.register(r.validated.body), 201),
);
routes.post('/auth/login', body(v.loginSchema), login);
routes.post('/auth/refresh', refresh);
routes.post('/auth/logout', logout);
routes.get(
  '/auth/me',
  authenticate,
  respond((r) => r.user),
);
routes.get(
  '/categories',
  respond(() => catalog.categories()),
);
routes.get(
  '/categories/:id',
  params,
  respond((r) => catalog.category(r.params.id)),
);
routes.post(
  '/categories',
  authenticate,
  admin,
  body(v.categorySchema),
  respond((r) => catalog.saveCategory(null, r.validated.body), 201),
);
routes.put(
  '/categories/:id',
  authenticate,
  admin,
  params,
  body(v.categorySchema),
  respond((r) => catalog.saveCategory(r.params.id, r.validated.body)),
);
routes.delete(
  '/categories/:id',
  authenticate,
  admin,
  params,
  respond(async (r) => {
    await catalog.deleteCategory(r.params.id);
    return { message: 'Category deactivated' };
  }),
);
routes.get(
  '/products',
  query(v.productsQuery),
  respond((r) => catalog.products(r.validated.query)),
);
routes.get(
  '/products/:id',
  params,
  respond((r) => catalog.product(r.params.id)),
);
routes.post(
  '/products',
  authenticate,
  admin,
  body(v.productSchema),
  respond((r) => catalog.saveProduct(null, r.validated.body), 201),
);
routes.put(
  '/products/:id',
  authenticate,
  admin,
  params,
  body(v.productSchema),
  respond((r) => catalog.saveProduct(r.params.id, r.validated.body)),
);
routes.delete(
  '/products/:id',
  authenticate,
  admin,
  params,
  respond(async (r) => {
    await catalog.deleteProduct(r.params.id);
    return { message: 'Product deactivated' };
  }),
);
routes.post(
  '/products/:id/inventory',
  authenticate,
  admin,
  params,
  body(v.inventorySchema),
  respond((r) => adjustStock(r.params.id, r.validated.body.quantity, r.user.id)),
);
routes.use('/orders', authenticate);
routes.post(
  '/orders',
  body(v.orderSchema),
  respond((r) => orderService.create(r.validated.body.items, r.user), 201),
);
routes.get(
  '/orders',
  query(v.orderQuery),
  respond((r) => orders.list(r.validated.query, r.user)),
);
routes.get(
  '/orders/:id',
  params,
  respond((r) => orders.get(r.params.id, r.user)),
);
routes.get(
  '/orders/:id/history',
  params,
  respond(async (r) => (await orders.get(r.params.id, r.user)).history),
);
routes.post(
  '/orders/:id/cancel',
  params,
  respond((r) => orderService.changeStatus(r.params.id, 'CANCELLED', r.user)),
);
routes.patch(
  '/orders/:id/status',
  admin,
  params,
  body(v.statusSchema),
  respond((r) => orderService.changeStatus(r.params.id, r.validated.body.status, r.user)),
);
routes.use('/reports', authenticate, admin);
for (const name of Object.keys(reports.reportSql))
  routes.get(
    `/reports/${name.replaceAll('_', '-')}`,
    query(v.reportQuery),
    respond((r) => reports.report(name, r.validated.query)),
  );
routes.get(
  '/reports/customers/:id/orders',
  params,
  query(v.orderQuery),
  respond((r) => reports.customerOrders(r.params.id, r.validated.query)),
);
