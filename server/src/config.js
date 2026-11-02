// Loads .env (if present) and validates every setting once at startup.
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Repository root (two levels above server/src). */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const envFile = resolve(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const num = (def) => z.coerce.number().default(def);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  PORT: num(8443),
  HTTP_REDIRECT_PORT: num(8080),
  HOST: z.string().default('0.0.0.0'),
  TLS_CERT: z.string().default('certs/lan.pem'),
  TLS_KEY: z.string().default('certs/lan-key.pem'),
  DB_PATH: z.string().default('db/smartcart.db'),
  INFERENCE_MODE: z.enum(['real', 'mock']).default('real'),
  INFERENCE_URL: z.string().url().default('http://127.0.0.1:8001'),
  INFERENCE_TIMEOUT_MS: num(2000),
  MODEL_PATH: z.string().optional(),
  WEIGHTS_ROOT: z.string().default('C:/Users/Acer/Desktop/SNP'),
  CONF_THRESHOLD: num(0.7),
  TRACKER_WINDOW: num(8),
  TRACKER_ADD_K: num(3),
  REASON_PAIR_WINDOW_MS: num(60000),
  ADMIN_EMAIL: z.string().email().default('admin@smartcart.co.th'),
  ADMIN_PASSWORD: z.string().min(1).default('change-me'),
  SESSION_SECRET: z.string().min(1).default('change-me'),
  DEV_STAFF_PASSWORD: z.string().min(1).default('staff1234'),
  LOG_FILE: z.string().default('logs/server.log'),
  LOGIN_MAX_ATTEMPTS: num(3),
  LOGIN_LOCK_MS: num(5 * 60 * 1000),
  SESSION_TTL_MS: num(12 * 60 * 60 * 1000),
  SESSION_REMEMBER_MS: num(7 * 24 * 60 * 60 * 1000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid configuration in .env:\n' + z.prettifyError(parsed.error));
  process.exit(1);
}

const env = parsed.data;
const fromRoot = (p) => (p === ':memory:' || isAbsolute(p) ? p : resolve(ROOT, p));

/** @typedef {typeof config} Config */
export const config = Object.freeze({
  ...env,
  isDev: env.NODE_ENV !== 'production',
  dbPath: fromRoot(env.DB_PATH),
  tlsCert: fromRoot(env.TLS_CERT),
  tlsKey: fromRoot(env.TLS_KEY),
  logFile: env.LOG_FILE ? fromRoot(env.LOG_FILE) : null,
  migrationsDir: resolve(ROOT, 'db', 'migrations'),
  seedDir: resolve(ROOT, 'db', 'seed'),
  webDir: resolve(ROOT, 'web'),
});

export default config;
