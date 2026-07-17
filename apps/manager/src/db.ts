// SQLite (better-sqlite3). Схема новой системы, совместимая с импортом из legacy
// (поля legacy_id, uuid, public_key сохраняют старые идентификаторы).

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const dir = path.dirname(config.databasePath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

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

CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
CREATE INDEX IF NOT EXISTS idx_devices_server ON devices(server_id);
CREATE INDEX IF NOT EXISTS idx_history_user ON user_history(user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_server ON jobs(server_id, state);
`);

// Миграции для существующих БД (ADD COLUMN идемпотентно — игнорируем дубликаты).
for (const stmt of [
  'ALTER TABLE servers ADD COLUMN ssh_pass_enc TEXT',
  'ALTER TABLE apps ADD COLUMN icon TEXT',
  'ALTER TABLE apps ADD COLUMN download_url TEXT',
  'ALTER TABLE server_keys ADD COLUMN proxy_enc TEXT',
  'ALTER TABLE server_keys ADD COLUMN awg_params TEXT',
]) {
  try {
    db.exec(stmt);
  } catch {
    /* колонка уже есть */
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
