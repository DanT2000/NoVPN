import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function env(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
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

  adminLogin: env('ADMIN_LOGIN', 'admin'),
  adminPassword: env('ADMIN_PASSWORD', 'admin'),

  sessionSecret: env('SESSION_SECRET', 'dev-insecure-session-secret-change-me'),
  encryptionKey: env('ENCRYPTION_KEY', ''),

  databasePath: env('DATABASE_PATH', path.join(__dirname, '../data/database.sqlite')),
  contentDir: env('CONTENT_DIR', path.join(__dirname, '../content')),
  // Каталог собранного фронтенда (в проде копируется в образ).
  webDist: env('WEB_DIST', path.join(__dirname, '../../web/dist')),

  agentEnrollmentTtlMin: int('AGENT_ENROLLMENT_TTL_MIN', 30),

  // Совместимость со старым push-агентом на время миграции.
  enableMockAgent: bool('ENABLE_MOCK_AGENT', true),
  legacyAgentUrl: env('VPN_AGENT_URL', ''),
  legacyAgentToken: env('VPN_AGENT_TOKEN', ''),

  sessionTtlHours: int('SESSION_TTL_HOURS', 24),
  // TLS обычно терминируется на edge/прокси, а контейнер видит http →
  // secure-cookie тогда молча не ставится. По умолчанию false; включать
  // только при прямом HTTPS до приложения.
  cookieSecure: bool('COOKIE_SECURE', false),
};

export type AppConfig = typeof config;
