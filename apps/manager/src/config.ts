import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function env(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

const databasePath = env('DATABASE_PATH', path.join(__dirname, '../data/database.sqlite'));
const dataDir = path.dirname(databasePath);

/** Ключ шифрования секретов. Приоритет: ENV → файл рядом с БД → автогенерация.
 *  Автогенерация + персист в data/encryption.key даёт установку БЕЗ единого ENV
 *  («распаковал — работает»): панель сама заведёт стабильный ключ при первом старте
 *  и переживёт рестарты (иначе зашифрованные секреты стали бы нечитаемы). Продвинутый
 *  пользователь по-прежнему может задать ENCRYPTION_KEY через окружение. */
function resolveEncryptionKey(): string {
  // Восстановление из бэкапа (v2): рядом лежит и снимок БД, и его ENCRYPTION_KEY.
  // Берём ключ из бэкапа (иначе секреты восстановленной базы не расшифруются даже с
  // ENV/автоключом нового хоста). db.ts затем сделает ключ постоянным.
  try {
    const pendingKey = `${databasePath}.pending-key`;
    if (fs.existsSync(pendingKey) && fs.existsSync(`${databasePath}.pending-restore`)) {
      const k = fs.readFileSync(pendingKey, 'utf8').trim();
      if (k) return k;
    }
  } catch {
    /* нет файлов восстановления */
  }
  const fromEnv = env('ENCRYPTION_KEY', '').trim();
  if (fromEnv) return fromEnv;
  const keyFile = path.join(dataDir, 'encryption.key');
  try {
    const existing = fs.readFileSync(keyFile, 'utf8').trim();
    if (/^[0-9a-fA-F]{64}$/.test(existing)) return existing;
  } catch {
    /* файла ещё нет — создадим ниже */
  }
  const key = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(keyFile, key, { mode: 0o600 });
  } catch {
    /* том только для чтения — вернём эфемерный ключ (переживёт до рестарта) */
  }
  return key;
}

const encryptionKey = resolveEncryptionKey();

/** Секрет подписи сессий. ENV SESSION_SECRET → иначе стабильно выводим из ключа
 *  шифрования (он теперь всегда есть). Так сессии секретны и переживают рестарт,
 *  а панель работает без единой переменной окружения. */
function resolveSessionSecret(): string {
  const s = env('SESSION_SECRET', '').trim();
  if (s) return s;
  return crypto.createHash('sha256').update(`novpn-session:${encryptionKey}`).digest('hex');
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
  encryptionKey,

  // Сколько доверенных прокси стоит перед панелью (openresty + traefik = 2).
  // От этого зависит, какой адрес Express считает адресом клиента, а значит —
  // работает ли лимит попыток входа. Значение 0 = обращаются напрямую.
  trustProxyHops: int('TRUST_PROXY_HOPS', 2),

  databasePath,
  // Файлы приложений (APK/EXE/AppImage) храним на диске рядом с базой (постоянный
  // том), а НЕ в SQLite: инсталляторы бывают по 60–120 МБ, base64 раздул бы базу.
  appsDir: env('APPS_DIR', path.join(dataDir, 'apps')),
  // Каталог собранного фронтенда (в проде копируется в образ).
  webDist: env('WEB_DIST', path.join(__dirname, '../../web/dist')),
  // Канал раздачи NoVPN Desktop: манифест + установщик + гайд. Отдаётся статикой по
  // /desktop/*. На ПОСТОЯННОМ томе (/data/desktop) — чтобы загрузка/авто-зеркало релизов
  // переживали редеплой (образ read-only). При первом старте сидим из встроенной версии.
  desktopDir: env('DESKTOP_DIR', path.join(dataDir, 'desktop')),
  // Встроенная (закоммиченная в образ) версия — источник первичного сида /data/desktop.
  desktopSeedDir: env('DESKTOP_SEED_DIR', path.join(__dirname, '../../../desktop')),

  sessionTtlHours: int('SESSION_TTL_HOURS', 168),
  // TLS обычно терминируется на edge/прокси, а контейнер видит http →
  // secure-cookie тогда молча не ставится. По умолчанию false; включать
  // только при прямом HTTPS до приложения.
  cookieSecure: bool('COOKIE_SECURE', false),
};

export type AppConfig = typeof config;
