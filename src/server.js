import { app, logger } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';
await pool.query('SELECT 1');
const server = app.listen(config.PORT, () => logger.info({ port: config.PORT }, 'API listening'));
let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'Shutting down');
  const timer = setTimeout(() => process.exit(1), 10000);
  timer.unref();
  server.close(async () => {
    try {
      await pool.end();
      clearTimeout(timer);
      process.exit(0);
    } catch {
      process.exit(1);
    }
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
