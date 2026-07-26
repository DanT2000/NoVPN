import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function env(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

/** Секрет подписи сессий. Если SESSION_SECRET не задан, в production выводим
 *  СТАБИЛЬНЫЙ секрет из ENCRYPTION_KEY (он в проде обязателен) — так сессии
 *  секретны и переживают рестарт, а панель не падает из-за забытой переменной.
 *  Небезопасный дефолт остаётся только для локальной разработки. */
function resolveSessionSecret(): string {
  const s = env('SESSION_SECRET', '');
  if (s) return s;
  const enc = env('ENCRYPTION_KEY', '');
  if (env('NODE_ENV') === 'production' && enc) {
    return crypto.createHash('sha256').update(`novpn-session:${enc}`).digest('hex');
  }
  return 'dev-insecure-session-secret-change-me';
}
function bool(name: string, fallback = false): boolean {
  const v = process.env[name];
  return v == null ? fallback : v === 'true' || v === '1';
}
function int(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  nodeEnv: env('NODE_ENV', 'development'),
  isProd: env('NODE_ENV') === 'production',
  port: int('PORT', 3000),
  appName: env('APP_NAME', 'NoVPN'),
  publicUrl: env('PUBLIC_URL', 'http://localhost:3000'),

  adminPassword: env('ADMIN_PASSWORD', 'admin'),

  sessionSecret: resolveSessionSecret(),
  encryptionKey: env('ENCRYPTION_KEY', ''),

  // Сколько доверенных прокси стоит перед панелью (openresty + traefik = 2).
  // От этого зависит, какой адрес Express считает адресом клиента, а значит —
  // работает ли лимит попыток входа. Значение 0 = обращаются напрямую.
  trustProxyHops: int('TRUST_PROXY_HOPS', 2),

  databasePath: env('DATABASE_PATH', path.join(__dirname, '../data/database.sqlite')),
  // Каталог собранного фронтенда (в проде копируется в образ).
  webDist: env('WEB_DIST', path.join(__dirname, '../../web/dist')),

  sessionTtlHours: int('SESSION_TTL_HOURS', 24),
  // TLS обычно терминируется на edge/прокси, а контейнер видит http →
  // secure-cookie тогда молча не ставится. По умолчанию false; включать
  // только при прямом HTTPS до приложения.
  cookieSecure: bool('COOKIE_SECURE', false),
};

export type AppConfig = typeof config;
