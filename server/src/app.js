// Express app factory (no listening here, so tests can mount it on any server).
import express from 'express';
import { loadUser, requireAuth } from './auth/middleware.js';
import { config } from './config.js';
import { errorHandler, HttpError } from './http/errors.js';
import { jsonOnly, requestLog, securityHeaders } from './http/security.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { catalogRoutes } from './routes/catalog.js';
import { metricsRoutes } from './routes/metrics.js';
import { sessionRoutes } from './routes/sessions.js';

const started = Date.now();

/**
 * @param {{ db: import('better-sqlite3').Database, hub: ReturnType<typeof import('./ws/hub.js').createHub>, log: import('pino').Logger,
 *           inference: ReturnType<typeof import('./pipeline/inferClient.js').createInference>,
 *           pipeline?: ReturnType<typeof import('./pipeline/index.js').createPipeline> }} deps
 */
export function createApp({ db, hub, log, inference, pipeline }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(requestLog(log));

  // device metrics come from navigator.sendBeacon (text/plain), so they are mounted before the JSON-only guard
  app.use('/api/metrics', metricsRoutes({ db, pipeline }));

  const api = express.Router();
  api.use(express.json({ limit: '100kb' }), jsonOnly(), loadUser(db));
  api.get('/health', (req, res) => res.json({
    ok: true, env: config.NODE_ENV, inference_mode: inference.mode, inference_ok: inference.status().ok,
    uptime_s: Math.round((Date.now() - started) / 1000), ws: hub.stats(), pipeline: pipeline?.stats() ?? null,
  }));
  // Public facts for the login page and customer screens (replaces numbers hard-coded in the prototype).
  api.get('/meta', (req, res) => {
    const store = db.prepare('SELECT name_th, code FROM stores ORDER BY store_id LIMIT 1').get();
    const counts = db.prepare('SELECT COUNT(*) AS products, SUM(in_model) AS in_model FROM products WHERE is_active = 1').get();
    const model = db.prepare('SELECT name, map50_95, latency_p95_ms, conf_threshold FROM model_versions WHERE is_active = 1').get() ?? null;
    res.json({ store, products: counts.products, products_in_model: counts.in_model ?? 0, active_model: model,
      demo_accounts: config.NODE_ENV === 'development' });
  });
  api.use('/auth', authRoutes({ db, log }));
  api.use('/sessions', sessionRoutes({ db, hub }));
  api.use('/products', requireAuth, catalogRoutes({ db }));
  api.use('/admin', requireAuth, adminRoutes({ db, hub, inference, log }));
  api.use((req, res, next) => next(new HttpError(404, 'NOT_FOUND', `ไม่พบ ${req.method} ${req.originalUrl}`)));
  app.use('/api', api);

  app.use(express.static(config.webDir, { index: 'index.html', maxAge: config.isDev ? 0 : '1h' }));
  app.use(errorHandler(log));
  return app;
}
