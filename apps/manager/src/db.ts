// SQLite (better-sqlite3). Схема новой системы, совместимая с импортом из legacy
// (поля legacy_id, uuid, public_key сохраняют старые идентификаторы).

import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const dir = path.dirname(config.databasePath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

// Восстановление из бэкапа: кнопка «Восстановить» кладёт рядом .pending-restore,
// а подменить открытый файл БД в рантайме нельзя. Поэтому подмену делаем здесь,
// до открытия базы. Прежнюю базу сохраняем как .replaced на всякий случай.
{
  const pending = `${config.databasePath}.pending-restore`;
  if (fs.existsSync(pending)) {
    for (const suf of ['-wal', '-shm']) {
      try {
        fs.rmSync(`${config.databasePath}${suf}`, { force: true });
      } catch {
        /* нет файла */
      }
    }
    if (fs.existsSync(config.databasePath)) {
      fs.renameSync(config.databasePath, `${config.databasePath}.replaced-${Date.now()}`);
    }
    fs.renameSync(pending, config.databasePath);
    // Ключ из бэкапа (v2) делаем постоянным: config.ts уже прочитал его для этого
    // старта, теперь кладём как encryption.key, чтобы следующие старты его использовали.
    const pendingKey = `${config.databasePath}.pending-key`;
    if (fs.existsSync(pendingKey)) {
      try {
        fs.renameSync(pendingKey, path.join(dir, 'encryption.key'));
      } catch {
        /* не удалось — секреты могут не расшифроваться, но БД восстановлена */
      }
    }
    console.log('[restore] база восстановлена из бэкапа');
  }
}

export const db = new Database(config.databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  comment TEXT DEFAULT '',
  category TEXT,
  tags TEXT DEFAULT '[]',
  code TEXT UNIQUE NOT NULL,
  device_limit INTEGER,
  expires_at TEXT,
  traffic_limit_gb REAL,
  traffic_used_gb REAL DEFAULT 0,
  reset_policy TEXT DEFAULT 'never',
  allowed_servers TEXT DEFAULT '[]',
  default_server_id TEXT,
  allowed_protocols TEXT DEFAULT '["xray"]',
  is_active INTEGER DEFAULT 1,
  telegram TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_activity_at TEXT,
  deleted_at TEXT,
  legacy_id INTEGER
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  name TEXT NOT NULL,
  server_id TEXT NOT NULL,
  protocol TEXT NOT NULL,
  is_active INTEGER DEFAULT 1,
  last_seen_at TEXT,
  traffic_gb REAL DEFAULT 0,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  revoke_pending INTEGER NOT NULL DEFAULT 0,
  quota_blocked INTEGER NOT NULL DEFAULT 0,
  os_hint TEXT,
  source TEXT DEFAULT 'managed',
  management_level TEXT DEFAULT 'managed',
  monitoring_available INTEGER DEFAULT 1,
  uuid TEXT,
  public_key TEXT,
  private_key_enc TEXT,
  preshared_key_enc TEXT,
  client_ip TEXT,
  link TEXT,
  conf TEXT,
  received_bytes INTEGER DEFAULT 0,
  sent_bytes INTEGER DEFAULT 0,
  legacy_id INTEGER
);

CREATE TABLE IF NOT EXISTS servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  country TEXT,
  host TEXT NOT NULL,
  agent TEXT DEFAULT 'never',
  endpoint_ok INTEGER DEFAULT 0,
  service_health TEXT DEFAULT 'unknown',
  protocols TEXT DEFAULT '[]',
  traffic_gb REAL DEFAULT 0,
  users INTEGER DEFAULT 0,
  is_default INTEGER DEFAULT 0,
  auto_issue INTEGER DEFAULT 1,
  last_sync_at TEXT,
  recommended INTEGER DEFAULT 0,
  agent_version TEXT,
  agent_public_key TEXT,
  enroll_secret_enc TEXT,
  ssh_host TEXT,
  ssh_port INTEGER,
  ssh_user TEXT,
  ssh_pass_enc TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  client TEXT NOT NULL,
  compat TEXT DEFAULT '[]',
  source TEXT DEFAULT '',
  store TEXT,
  version TEXT DEFAULT '',
  local_file TEXT,
  instruction TEXT DEFAULT '',
  enabled INTEGER DEFAULT 1,
  sort INTEGER DEFAULT 0,
  icon TEXT,
  download_url TEXT
);

-- Клиент-приложения хранятся как JSON (клиент-центричная модель с платформами).
CREATE TABLE IF NOT EXISTS app_clients (
  id TEXT PRIMARY KEY,
  sort INTEGER DEFAULT 0,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS admin_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  server TEXT NOT NULL,
  text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  at TEXT NOT NULL,
  text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT DEFAULT '{}',
  state TEXT DEFAULT 'queued',
  progress INTEGER DEFAULT 0,
  result TEXT,
  error TEXT,
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Периодические снимки метрик (для графиков истории: трафик/пользователи/устройства
-- по дням/неделям/месяцам). Пишется throttled из sync-цикла, старое чистится.
CREATE TABLE IF NOT EXISTS stats_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  traffic_gb REAL NOT NULL DEFAULT 0,
  active_users INTEGER NOT NULL DEFAULT 0,
  active_devices INTEGER NOT NULL DEFAULT 0,
  used_devices INTEGER NOT NULL DEFAULT 0,
  online_servers INTEGER NOT NULL DEFAULT 0,
  total_servers INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_stats_at ON stats_samples(at);

-- События смены состояния сервера (online<->offline) — для аптайма/инцидентов
-- в стиле Uptime Kuma. Пишем ТОЛЬКО при смене состояния (компактно).
CREATE TABLE IF NOT EXISTS server_status_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL,
  at TEXT NOT NULL,
  online INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sse_server ON server_status_events(server_id, at);

-- Серверные ключи по ДОМЕНУ — для восстановления при замене сервера.
-- Если новый сервер поднимается на том же домене, эти ключи подставляются →
-- старые клиентские конфиги продолжают работать.
CREATE TABLE IF NOT EXISTS server_keys (
  domain TEXT PRIMARY KEY,
  awg_server_privkey_enc TEXT,
  awg_server_pubkey TEXT,
  xray_reality_privkey_enc TEXT,
  xray_reality_pubkey TEXT,
  xray_short_id TEXT,
  xray_sni TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proxy_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  server_id TEXT NOT NULL,
  login TEXT NOT NULL,
  pass_enc TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  received_bytes INTEGER NOT NULL DEFAULT 0,
  sent_bytes INTEGER NOT NULL DEFAULT 0,
  rx_raw INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  quota_blocked INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
CREATE INDEX IF NOT EXISTS idx_devices_server ON devices(server_id);
CREATE INDEX IF NOT EXISTS idx_history_user ON user_history(user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_server ON jobs(server_id, state);
CREATE INDEX IF NOT EXISTS idx_proxy_user ON proxy_accounts(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_proxy_login ON proxy_accounts(server_id, login);
`);

// Миграции для существующих БД (ADD COLUMN идемпотентно — игнорируем дубликаты).
for (const stmt of [
  'ALTER TABLE servers ADD COLUMN ssh_pass_enc TEXT',
  'ALTER TABLE apps ADD COLUMN icon TEXT',
  'ALTER TABLE apps ADD COLUMN download_url TEXT',
  'ALTER TABLE server_keys ADD COLUMN proxy_enc TEXT',
  'ALTER TABLE server_keys ADD COLUMN awg_params TEXT',
  // Личная ссылка входа: длинный токен вместо набираемого руками кода.
  'ALTER TABLE users ADD COLUMN access_token TEXT',
  // До какого момента этому пользователю разрешён вход по 6-значному коду.
  // NULL = нельзя вовсе (так у всех, кого завели после перехода на ссылки).
  'ALTER TABLE users ADD COLUMN code_login_until TEXT',
  // Последнее СЫРОЕ показание счётчиков с сервера. Нужно, чтобы считать прирост:
  // счётчики ядра обнуляются при перезапуске интерфейса, и без этого
  // потреблённый трафик пользователя обнулялся вместе с ними.
  // Токен подписки Xray: отдельный от токена входа, живёт в VPN-приложении.
  'ALTER TABLE users ADD COLUMN sub_token TEXT',
  'ALTER TABLE devices ADD COLUMN rx_raw INTEGER DEFAULT 0',
  'ALTER TABLE devices ADD COLUMN tx_raw INTEGER DEFAULT 0',
  // Числовой chat_id Telegram: поле telegram хранит только handle (@username),
  // а бот-рассылка требует именно chat_id. Заполняется при привязке и при любом
  // входящем сообщении от привязанного пользователя (бэкофилл для старых).
  'ALTER TABLE users ADD COLUMN telegram_chat_id INTEGER',
  // Типы прокси, которые пользователю разрешено выдать себе (JSON-массив).
  'ALTER TABLE users ADD COLUMN allowed_proxies TEXT',
  // Трафик прокси-аккаунта (сумма из логов 3proxy). rx_raw — сырое показание
  // за текущий день (для вычисления прироста; при ротации лога сбрасывается).
  'ALTER TABLE proxy_accounts ADD COLUMN received_bytes INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE proxy_accounts ADD COLUMN sent_bytes INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE proxy_accounts ADD COLUMN rx_raw INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE proxy_accounts ADD COLUMN last_seen_at TEXT',
  // Трафик удалённых устройств, «списанный» на пользователя: расход считается по
  // сумме устройств, и физическое удаление конфига иначе уменьшало бы traffic_used_gb
  // (можно было бы вернуть квоту, удалив/очистив конфиг). Копим отдельно.
  'ALTER TABLE users ADD COLUMN retired_traffic_gb REAL NOT NULL DEFAULT 0',
  // «Отзыв ожидает подтверждения»: конфиг отключён в панели, но серверный отзов
  // по SSH не удался (сервер был недоступен). Такие НЕ чистим (revoked_at не ставим,
  // иначе осиротеет живой конфиг), а повторяем отзыв в sync до подтверждения.
  'ALTER TABLE devices ADD COLUMN revoke_pending INTEGER NOT NULL DEFAULT 0',
  // Пир снят с сервера из-за исчерпанной квоты (запись и ключи сохранены). При
  // восстановлении лимита пир возвращается на сервер — reissue не нужен.
  'ALTER TABLE devices ADD COLUMN quota_blocked INTEGER NOT NULL DEFAULT 0',
  // Уровень записи журнала ошибок: 'error' | 'warn' | 'info' — для красивого вида
  // и фильтрации логов в админке.
  "ALTER TABLE job_errors ADD COLUMN level TEXT NOT NULL DEFAULT 'error'",
  // Прокси-логин снят с сервера по квоте (обратимо, симметрично устройствам): при
  // возврате под лимит логин поднимается заново тем же паролем. is_active остаётся 1.
  'ALTER TABLE proxy_accounts ADD COLUMN quota_blocked INTEGER NOT NULL DEFAULT 0',
  // Реально используемые конфиги на момент снимка (были на связи за ~сутки) — для
  // графика «Активность» (реальное использование, а не число выданных).
  'ALTER TABLE stats_samples ADD COLUMN used_devices INTEGER NOT NULL DEFAULT 0',
]) {
  try {
    db.exec(stmt);
  } catch {
    /* колонка уже есть */
  }
}

try {
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_token ON users(access_token)');
} catch {
  /* индекс уже есть */
}
try {
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_subtoken ON users(sub_token)');
} catch {
  /* индекс уже есть */
}

// Один chat_id Telegram = один пользователь. Сначала чистим возможные дубли из
// старых данных (удалённые записи и «залипшие» вторые строки на тот же chat_id),
// затем ставим ЧАСТИЧНЫЙ уникальный индекс. Без этого захват/дубли рассылки.
try {
  db.exec("UPDATE users SET telegram_chat_id = NULL WHERE deleted_at IS NOT NULL AND telegram_chat_id IS NOT NULL");
  db.exec(
    `UPDATE users SET telegram_chat_id = NULL
      WHERE telegram_chat_id IS NOT NULL
        AND rowid NOT IN (SELECT MAX(rowid) FROM users WHERE telegram_chat_id IS NOT NULL GROUP BY telegram_chat_id)`,
  );
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tg_chat ON users(telegram_chat_id) WHERE telegram_chat_id IS NOT NULL');
} catch {
  // Индекс — усиление; при неожиданных данных не блокируем старт панели (запись
  // всё равно защищена транзакцией в setTelegramChatId).
}

// Выдать токен подписки всем, у кого его ещё нет.
{
  const rows = db.prepare('SELECT id FROM users WHERE sub_token IS NULL').all() as Array<{ id: string }>;
  if (rows.length) {
    const upd = db.prepare('UPDATE users SET sub_token = ? WHERE id = ?');
    const tx = db.transaction((list: Array<{ id: string }>) => {
      for (const r of list) upd.run(crypto.randomBytes(18).toString('base64url'), r.id);
    });
    tx(rows);
    console.log(`[migrate] выдал токены подписки: ${rows.length}`);
  }
}

// Миграция reality-SNI: vk.com заезжен reality-серверами и режется российским DPI
// (проверено на реальной сети). Переводим на cdn.dodostatic.net + fp=edge + spx=/.
// Обновляем СОХРАНЁННЫЙ SNI серверов (чтобы переустановка восстановила новый) и
// перегенерируем существующие xray-ссылки (uuid/pbk/sid не трогаем — только маскировку).
// Серверный server.json меняется отдельно переустановкой сервера из панели.
try {
  const changed = db.prepare("UPDATE server_keys SET xray_sni = 'cdn.dodostatic.net' WHERE xray_sni = 'vk.com'").run().changes ?? 0;
  const rows = db.prepare("SELECT id, link FROM devices WHERE protocol = 'xray' AND link LIKE '%sni=vk.com%'").all() as Array<{ id: string; link: string }>;
  const upd = db.prepare('UPDATE devices SET link = ? WHERE id = ?');
  const tx = db.transaction((list: Array<{ id: string; link: string }>) => {
    for (const r of list) {
      let link = r.link.replace('sni=vk.com', 'sni=cdn.dodostatic.net').replace('fp=chrome', 'fp=edge');
      if (!/[?&]spx=/.test(link)) link = link.replace('&flow=', '&spx=%2F&flow=');
      upd.run(link, r.id);
    }
  });
  tx(rows);
  if (changed || rows.length) console.log(`[migrate] reality SNI → cdn.dodostatic.net: серверов ${changed}, ссылок ${rows.length}`);
} catch {
  /* не критично — не блокируем старт */
}

// До перехода на накопительный учёт received_bytes/sent_bytes хранили СЫРОЕ
// показание счётчика сервера. Переносим его в rx_raw/tx_raw как «уже учтённое»,
// иначе первая же синхронизация посчитает весь прошлый трафик приростом и
// удвоит его всем.
{
  const n = db.prepare('SELECT COUNT(*) AS n FROM devices WHERE rx_raw = 0 AND received_bytes > 0').get() as { n: number };
  if (n.n) {
    db.prepare('UPDATE devices SET rx_raw = received_bytes, tx_raw = sent_bytes WHERE rx_raw = 0 AND received_bytes > 0').run();
    console.log(`[migrate] перенёс показания счётчиков у устройств: ${n.n}`);
  }
}

// Шаблон сообщения со старой формулировкой «введите код на сайте» заменяем на
// новый — со ссылкой. Трогаем только если админ не редактировал его сам
// (значение всё ещё равно старому дефолту).
{
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'settings'").get() as { value: string } | undefined;
  if (row) {
    try {
      const s = JSON.parse(row.value);
      const OLD =
        'Ваш доступ NoVPN:\n\nКод: {code}\nСайт: {url}\nДействует до: {expires}\n\nВведите код на сайте — конфигурация выдаётся автоматически.';
      if (s && s.messageTemplate === OLD) {
        s.messageTemplate =
          'Ваш доступ NoVPN:\n\n{link}\n\nПерейдите по ссылке — откроется личный кабинет, вводить ничего не нужно. Там подключите устройство и получите конфигурацию.\n\nДействует до: {expires}';
        db.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run(JSON.stringify(s), 'settings');
        console.log('[migrate] обновлён шаблон сообщения на вариант со ссылкой');
      }
    } catch {
      /* нечитаемое значение — не трогаем */
    }
  }
}

// Разовая миграция существующих пользователей: выдать личную ссылку каждому и
// разрешить старый вход по коду ещё на 30 дней — чтобы никто не потерял доступ
// в момент выкатки. Новые пользователи заводятся сразу без входа по коду.
{
  const rows = db.prepare('SELECT id FROM users WHERE access_token IS NULL').all() as Array<{ id: string }>;
  if (rows.length) {
    const until = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const upd = db.prepare('UPDATE users SET access_token = ?, code_login_until = ? WHERE id = ?');
    const tx = db.transaction((list: Array<{ id: string }>) => {
      for (const r of list) upd.run(crypto.randomBytes(18).toString('base64url'), until, r.id);
    });
    tx(rows);
    console.log(`[migrate] выдал личные ссылки: ${rows.length}; вход по коду для них действует до ${until.slice(0, 10)}`);
  }
}

export function getSetting<T>(key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(key: string, value: unknown): void {
  db.prepare('INSERT INTO app_settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    JSON.stringify(value),
  );
}
