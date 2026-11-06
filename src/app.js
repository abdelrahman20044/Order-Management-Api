import { randomUUID } from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { ZodError } from 'zod';
import { config } from './config.js';
import { pool } from './db.js';
import { routes } from './routes.js';
import { AppError } from './errors.js';
export const logger = pino({
  level: config.LOG_LEVEL,
  redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
});
pool.on('error', (error) => logger.error({ err: error }, 'Idle database client error'));
export const app = express();
app.disable('x-powered-by');
// Trust proxy remains false. Configure a precise trusted-hop policy for your deployment.
app.use(
  pinoHttp({
    logger,
    genReqId: (_req, res) => {
      const id = randomUUID();
      res.setHeader('X-Request-ID', id);
      return id;
    },
  }),
);
app.use(helmet());
app.use(cors({ origin: config.CORS_ORIGINS.split(',').map((s) => s.trim()), credentials: true }));
app.use(express.json({ limit: '32kb' }));
app.use(cookieParser());
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch {
    res.status(503).json({ status: 'unavailable' });
  }
});
app.use('/api', routes);
app.use((_req, _res, next) => next(new AppError(404, 'Route not found', 'NOT_FOUND')));
app.use((err, req, res, _next) => {
  let status = err.status ?? 500,
    code = err.code ?? 'INTERNAL_ERROR',
    message = err.message;
  if (err instanceof ZodError) {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = 'Invalid request';
  } else if (err.code === '23505') {
    status = 409;
    code = 'CONFLICT';
    message = 'Resource already exists';
  } else if (err.code === '23503') {
    status = 409;
    code = 'INVALID_REFERENCE';
    message = 'Related resource does not exist';
  } else if (err.type === 'entity.parse.failed') {
    status = 400;
    code = 'INVALID_JSON';
    message = 'Malformed JSON';
  }
  if (status >= 500) {
    logger.error({ err, requestId: req.id }, 'Request failed');
    code = 'INTERNAL_ERROR';
    message = 'An unexpected error occurred';
  }
  res.status(status).json({
    error: {
      code,
      message,
      requestId: req.id,
      ...(err instanceof ZodError
        ? { details: err.issues.map((i) => ({ path: i.path, message: i.message })) }
        : {}),
    },
  });
});
