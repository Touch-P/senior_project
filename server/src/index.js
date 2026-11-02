// Smart Cart server: static UI + REST + WebSocket on one port.
//   HTTPS on HOST:PORT when TLS_CERT/TLS_KEY exist (+ HTTP_REDIRECT_PORT -> HTTPS).
//   Without certificates: development falls back to plain HTTP on 127.0.0.1 only; production refuses to start.
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createApp } from './app.js';
import { purgeExpiredSessions } from './auth/sessions.js';
import { config } from './config.js';
import { openDb } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { seed } from './db/seed.js';
import { logger } from './logger.js';
import { createHub } from './ws/hub.js';
import { attachWebSockets } from './ws/server.js';

const log = logger.child({ mod: 'server' });

async function main() {
  const db = openDb();
  migrate(db);
  await seed(db); // idempotent: product master + model coverage sync on every start
  if (config.ADMIN_PASSWORD === 'change-me' || config.SESSION_SECRET === 'change-me') {
    log.warn('ADMIN_PASSWORD / SESSION_SECRET are still "change-me" — set them in .env');
  }

  const hub = createHub();
  const app = createApp({ db, hub, log });
  const hasTls = existsSync(config.tlsCert) && existsSync(config.tlsKey);

  let server, redirect = null, url;
  if (hasTls) {
    server = https.createServer({ cert: readFileSync(config.tlsCert), key: readFileSync(config.tlsKey) }, app);
    server.listen(config.PORT, config.HOST);
    url = `https://localhost:${config.PORT}`;
    redirect = http.createServer((req, res) => {
      const host = (req.headers.host ?? 'localhost').replace(/:\d+$/, '');
      res.writeHead(301, { Location: `https://${host}:${config.PORT}${req.url}` }).end();
    }).listen(config.HTTP_REDIRECT_PORT, config.HOST);
  } else if (config.NODE_ENV === 'development') {
    server = http.createServer(app);
    server.listen(config.PORT, '127.0.0.1');
    url = `http://localhost:${config.PORT}`;
    log.warn({ cert: config.tlsCert }, 'no TLS certificate: HTTP on 127.0.0.1 only (phones cannot connect until Phase 5: scripts/lan-https.ps1)');
  } else {
    log.fatal({ cert: config.tlsCert, key: config.tlsKey }, 'TLS certificate not found; refusing to start without HTTPS outside development');
    process.exit(1);
  }

  const ws = attachWebSockets(server, { db, hub, log });
  server.on('listening', () => log.info({ url, https: hasTls, inference: config.INFERENCE_MODE }, `Smart Cart ready at ${url}`));
  server.on('error', (err) => { log.fatal({ err: err.message }, 'server failed to start'); process.exit(1); });

  const purge = setInterval(() => purgeExpiredSessions(db), 60 * 60 * 1000);
  purge.unref();

  const shutdown = (signal) => {
    log.info({ signal }, 'shutting down');
    clearInterval(purge);
    ws.close();
    redirect?.close();
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log.fatal({ err }, 'startup failed');
  process.exit(1);
});
