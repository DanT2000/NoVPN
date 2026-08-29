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

-- Умная маршрутизация: три управляемых JSON-файла (upstream/sites/apps) для NoVPN
-- Desktop. content — ровно то, что отдаётся по /routing/<name>.json (версия НЕ вшита
-- внутрь). Каждый файл независимо: локальный или зеркало внешнего URL.
CREATE TABLE IF NOT EXISTS routing_files (
  name TEXT PRIMARY KEY,
  content TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  root_type TEXT,
  entry_count INTEGER,
  mode TEXT NOT NULL DEFAULT 'local',
  source_url TEXT NOT NULL DEFAULT '',
  auto_sync INTEGER NOT NULL DEFAULT 0,
  etag TEXT,
  last_modified TEXT,
  last_check_at TEXT,
  last_ok_at TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  status_reason TEXT NOT NULL DEFAULT '',
  last_added INTEGER,
  last_removed INTEGER,
  source_stats TEXT
);

-- AutoRoute: источники, из которых собирается Upstream. Много источников на датасет,
-- порядок = приоритет (priority 0 — самый приоритетный). Колонка cached хранит
-- последний УСПЕШНО разобранный набор правил (last-known-good): сборка не должна
-- падать из-за того, что один источник сейчас недоступен.
CREATE TABLE IF NOT EXISTS routing_sources (
  id TEXT PRIMARY KEY,
  dataset TEXT NOT NULL DEFAULT 'upstream',
  title TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'auto',
  resolved_format TEXT,
  action TEXT NOT NULL DEFAULT 'vpn',
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  etag TEXT,
  last_modified TEXT,
  last_check_at TEXT,
  last_ok_at TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  status_reason TEXT NOT NULL DEFAULT '',
  stats TEXT,
  cached TEXT,
  cached_count INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_routing_sources_ds ON routing_sources(dataset, priority);

-- История сборок AutoRoute: версия, чем отличается от предыдущей, и полное
-- содержимое — чтобы «Откатить» возвращал ровно то, что было опубликовано.
CREATE TABLE IF NOT EXISTS routing_builds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset TEXT NOT NULL,
  version INTEGER NOT NULL,
  built_at TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  domains INTEGER NOT NULL DEFAULT 0,
  ips INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  conflicts INTEGER NOT NULL DEFAULT 0,
  sources_changed INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL DEFAULT '[]',
  rules TEXT NOT NULL DEFAULT '[]',
  published INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_routing_builds_ver ON routing_builds(dataset, version);

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
  // ── Профили подписки Xray ──
  // Какие профили выдаёт сервер: 'smart' | 'full' | 'both' (NULL = унаследовать из
  // xray_whitelist: true→both, false→full — см. бэкфилл ниже).
  'ALTER TABLE server_keys ADD COLUMN profiles TEXT',
  // Новым пользователям сервера Полный VPN разрешён по умолчанию (1) или закрыт (0).
  'ALTER TABLE server_keys ADD COLUMN full_default INTEGER',
  // Направление умного профиля: 'match-vpn' (список → VPN, остальное напрямую) или
  // 'match-direct' (унаследованный обход белых списков). NULL = match-vpn.
  'ALTER TABLE server_keys ADD COLUMN smart_direction TEXT',
  // Источник списка умного профиля: 'autoroute' (сборка) или 'local' (свой список). NULL = autoroute.
  'ALTER TABLE server_keys ADD COLUMN smart_source TEXT',
  // Подмена DNS (FakeDNS) в умном профиле. Нужна там, где домена в трафике не видно —
  // TLS с зашифрованным SNI (ECH), не-HTTP протоколы: без неё такие соединения
  // маршрутизируются только по IP. NULL/0 = выключено (поведение по умолчанию).
  'ALTER TABLE server_keys ADD COLUMN fake_dns INTEGER',
  // Серверы, на которых пользователю разрешён профиль «Полный VPN» (JSON-массив id).
  'ALTER TABLE users ADD COLUMN full_servers TEXT',
  // Прокси-логин снят с сервера по квоте (обратимо, симметрично устройствам): при
  // возврате под лимит логин поднимается заново тем же паролем. is_active остаётся 1.
  'ALTER TABLE proxy_accounts ADD COLUMN quota_blocked INTEGER NOT NULL DEFAULT 0',
  // Реально используемые конфиги на момент снимка (были на связи за ~сутки) — для
  // графика «Активность» (реальное использование, а не число выданных).
  'ALTER TABLE stats_samples ADD COLUMN used_devices INTEGER NOT NULL DEFAULT 0',
  // ── Endpoint Profile: server_keys (по домену) хранит и ПОРТЫ endpoint'а ──
  // Публичные порты компонентов. NULL = легаси-дефолт (443/51820/8080/1080/8443),
  // поэтому существующие установки продолжают работать без изменений.
  'ALTER TABLE server_keys ADD COLUMN port_xray INTEGER',
  'ALTER TABLE server_keys ADD COLUMN port_awg INTEGER',
  'ALTER TABLE server_keys ADD COLUMN port_http INTEGER',
  'ALTER TABLE server_keys ADD COLUMN port_socks INTEGER',
  'ALTER TABLE server_keys ADD COLUMN port_https INTEGER',
  // Legacy-алиасы портов: [{proto,'port',since}] — старый порт продолжает вести на
  // новый (iptables), чтобы уже выданные конфиги оставались живыми после смены порта.
  "ALTER TABLE server_keys ADD COLUMN legacy_ports TEXT NOT NULL DEFAULT '[]'",
  // Сервер «отвязан»: физическая машина удалена/недоступна, но endpoint (домен, порты,
  // ключи, связь с выданными конфигами) сохранён — серый статус, sync пропускает.
  'ALTER TABLE servers ADD COLUMN detached INTEGER NOT NULL DEFAULT 0',
  // SSH-ключ панели для входа на сервер (взамен пароля после hardening).
  'ALTER TABLE servers ADD COLUMN ssh_key_enc TEXT',
  // Выдача помечена «нужно обновить» (legacy-порт отключён — старый конфиг больше не работает).
  'ALTER TABLE devices ADD COLUMN needs_refresh INTEGER NOT NULL DEFAULT 0',
  // ── Пер-серверные настройки генерации конфига (в Endpoint Profile) ──
  // Всё это — параметры конфига НА УСТРОЙСТВЕ (маршрутизация/фоллбэк), не серверная
  // служба. NULL = наследовать глобальную настройку (обратная совместимость).
  'ALTER TABLE server_keys ADD COLUMN xray_whitelist INTEGER',      // продвинутый режим для этого сервера
  'ALTER TABLE server_keys ADD COLUMN whitelist_domains TEXT',       // свой список обхода (JSON), NULL=глоб/дефолт
  'ALTER TABLE server_keys ADD COLUMN lan_access INTEGER',           // доступ в локалку для этого сервера
  "ALTER TABLE server_keys ADD COLUMN fallback_types TEXT",         // какие прокси-фоллбэки использовать (JSON ['https','http','socks'])
  // Свой значок сервера (эмодзи): если задан — показывается в подписке вместо флага
  // страны. Общая настройка (не исключение): для self-host можно поставить 🏠, для
  // любого сервера — любой эмодзи. Пусто = флаг страны.
  'ALTER TABLE servers ADD COLUMN flag_emoji TEXT',
  // Умная маршрутизация: статистика конвертации внешнего источника (LST/TXT/SRS →
  // JSON) — {format, lines, valid, skipped, dups}. NULL, пока не синхронизировали.
  'ALTER TABLE routing_files ADD COLUMN source_stats TEXT',
]) {
  try {
    db.exec(stmt);
  } catch {
    /* колонка уже есть */
  }
}

// AutoRoute: прежний одиночный внешний источник Upstream переносим в список
// источников, чтобы настройка не потерялась при переходе на многоисточниковую
// сборку. Делается один раз — только пока у датасета нет ни одного источника.
try {
  db.prepare(
    `INSERT INTO routing_sources(id, dataset, title, url, format, action, enabled, priority, created_at)
     SELECT 'rs_legacy_upstream', 'upstream', 'Прежний внешний источник', source_url, 'auto', 'vpn', 1, 0, ?
       FROM routing_files
      WHERE name = 'upstream' AND mode = 'mirror' AND TRIM(source_url) != ''
        AND NOT EXISTS (SELECT 1 FROM routing_sources WHERE dataset = 'upstream')`,
  ).run(new Date().toISOString());
} catch {
  /* таблиц ещё нет */
}

// Файл `sites` упразднён окончательно: список сайтов — локальная настройка пользователя
// в NoVPN Desktop, с панелью не синхронизируется. Строку убираем, чтобы публичный URL
// не висел; клиент при 404 живёт своим локальным списком.
try {
  db.prepare("DELETE FROM routing_files WHERE name = 'sites'").run();
} catch {
  /* таблицы ещё нет */
}

// AutoRoute: источники по умолчанию — «что не работает в России». GitHub-списки идут
// через зеркало ghfast.top: с хоста панели (107_AppsServer) raw.githubusercontent.com,
// jsdelivr, statically и gitmirror недоступны (проверено с самой панели), зеркало и
// antifilter.download — доступны. Прямые github-URL у сидированных источников
// переписываем на зеркало. Добавляются один
// раз, только если у датасета ещё нет ни одного источника с таким URL. Порядок =
// приоритет: курируемый компактный список первым, объёмные — ниже.
try {
  const DEFAULT_SOURCES: Array<{ id: string; title: string; url: string }> = [
    { id: 'rs_itdog_inside', title: 'itdoginfo · заблокировано в России', url: 'https://ghfast.top/https://raw.githubusercontent.com/itdoginfo/allow-domains/main/Russia/inside-raw.lst' },
    { id: 'rs_refilter_domains', title: 'Re:filter · домены', url: 'https://ghfast.top/https://raw.githubusercontent.com/1andrevich/Re-filter-lists/main/domains_all.lst' },
    { id: 'rs_refilter_ips', title: 'Re:filter · IP-подсети', url: 'https://ghfast.top/https://raw.githubusercontent.com/1andrevich/Re-filter-lists/main/ipsum.lst' },
    { id: 'rs_antifilter_community', title: 'Antifilter Community · домены', url: 'https://community.antifilter.download/list/domains.lst' },
  ];
  const have = new Set((db.prepare("SELECT url FROM routing_sources WHERE dataset = 'upstream'").all() as Array<{ url: string }>).map((r) => r.url));
  let next = ((db.prepare("SELECT MAX(priority) AS m FROM routing_sources WHERE dataset = 'upstream'").get() as { m: number | null }).m ?? -1) + 1;
  const ins = db.prepare(
    `INSERT OR IGNORE INTO routing_sources(id, dataset, title, url, format, action, enabled, priority, created_at)
     VALUES(?, 'upstream', ?, ?, 'auto', 'vpn', 1, ?, ?)`,
  );
  for (const s of DEFAULT_SOURCES) {
    if (have.has(s.url)) continue;
    ins.run(s.id, s.title, s.url, next++, new Date().toISOString());
  }
  // Подсети Telegram — отдельными источниками и ВЫШЕ объёмных списков. Почему выше:
  // их единицы, а Re:filter даёт десятки тысяч подсетей, и при общем потолке подписки
  // (6000 IP) телеграмовские диапазоны оказывались за границей — мессенджер шёл
  // напрямую и упирался в блокировку. Встроенный список уже покрывает известное на
  // сегодня; эти источники приносят то, что появится ПОЗЖЕ, без правок кода.
  const TG_SOURCES: Array<{ id: string; title: string; url: string }> = [
    { id: 'rs_tg_ipv4', title: 'Telegram · подсети IPv4', url: 'https://ghfast.top/https://raw.githubusercontent.com/itdoginfo/allow-domains/main/Subnets/IPv4/telegram.lst' },
    { id: 'rs_tg_ipv6', title: 'Telegram · подсети IPv6', url: 'https://ghfast.top/https://raw.githubusercontent.com/itdoginfo/allow-domains/main/Subnets/IPv6/telegram.lst' },
  ];
  const tgMissing = TG_SOURCES.filter((s) => !have.has(s.url));
  if (tgMissing.length) {
    // Освобождаем начало очереди: остальные источники сдвигаются, телеграмовские — первыми.
    db.prepare("UPDATE routing_sources SET priority = priority + ? WHERE dataset = 'upstream'").run(tgMissing.length);
    let tgPriority = 0;
    for (const s of tgMissing) ins.run(s.id, s.title, s.url, tgPriority++, new Date().toISOString());
  }

  // Сидированные источники, оставшиеся на прямом github, — на зеркало (только наши id:
  // источники, добавленные администратором руками, не трогаем).
  for (const id of ['rs_legacy_upstream', 'rs_itdog_inside', 'rs_refilter_domains', 'rs_refilter_ips']) {
    db.prepare("UPDATE routing_sources SET url = REPLACE(url, 'https://raw.githubusercontent.com/', 'https://ghfast.top/https://raw.githubusercontent.com/'), etag = NULL, last_modified = NULL, status = 'idle', status_reason = '' WHERE id = ? AND url LIKE 'https://raw.githubusercontent.com/%'").run(id);
  }
  // После переписывания на зеркало унаследованный источник и сидированный itdoginfo
  // стали одним и тем же URL — второй экземпляр убираем (кеш у обоих одинаковый).
  db.prepare(
    `DELETE FROM routing_sources WHERE id = 'rs_itdog_inside'
       AND EXISTS (SELECT 1 FROM routing_sources l WHERE l.id = 'rs_legacy_upstream' AND l.url = routing_sources.url)`,
  ).run();
  // Унаследованный источник дублирует itdoginfo по URL — под общим именем он понятнее.
  db.prepare("UPDATE routing_sources SET title = 'itdoginfo · заблокировано в России' WHERE id = 'rs_legacy_upstream' AND title = 'Прежний внешний источник'").run();
} catch {
  /* таблиц ещё нет */
}

// Профили подписки: бэкфилл. Серверы, которые выдавали «умный» конфиг, теперь выдают
// ОБА профиля у всех пользователей (владелец: полный VPN никому не запрещаем — на
// сервере ничего не блокируется, лишний трафик — лимиты самого человека); серверы с
// полным туннелем — только полный.
try {
  db.prepare("UPDATE server_keys SET profiles = CASE WHEN xray_whitelist = 0 THEN 'full' ELSE 'both' END WHERE profiles IS NULL").run();
} catch {
  /* таблиц ещё нет */
}

// Схлопывание расщеплённых строк server_keys. Раньше keyvault писал ключи по
// НОРМАЛИЗОВАННОМУ домену (lower/без порта), а repo — порты/legacy/endpoint-config по
// сырому host. При неканоничном host один сервер жил двумя строками: ключи в одной,
// порты и настройки в другой → восстановление брало DEFAULT_PORTS и выданные конфиги
// отваливались. Теперь всё нормализуется; переносим данные осиротевших строк в
// каноническую (только там, где в канонической пусто) и удаляем дубль.
try {
  const rows = db.prepare('SELECT domain FROM server_keys').all() as Array<{ domain: string }>;
  const canon = (h: string) => h.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[:/].*$/, '');
  const cols = (db.prepare("PRAGMA table_info(server_keys)").all() as Array<{ name: string }>)
    .map((c) => c.name)
    .filter((n) => n !== 'domain');
  for (const { domain } of rows) {
    const key = canon(domain);
    if (key === domain) continue; // уже канонична
    const tx = db.transaction(() => {
      db.prepare('INSERT INTO server_keys(domain, updated_at) VALUES(?, ?) ON CONFLICT(domain) DO NOTHING').run(key, new Date().toISOString());
      for (const c of cols) {
        db.prepare(`UPDATE server_keys SET ${c} = (SELECT ${c} FROM server_keys WHERE domain = @old) WHERE domain = @new AND ${c} IS NULL`).run({ old: domain, new: key });
      }
      db.prepare('DELETE FROM server_keys WHERE domain = ?').run(domain);
    });
    tx();
  }
} catch {
  /* таблицы/строк ещё нет */
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

// Ссылка «скачать» у нашего приложения вела на raw.githubusercontent.com/.../desktop/vpn.exe.
// Файл давно называется novpn.exe (эта ссылка отдавала 404), да и GitHub у части людей
// не открывается — качать надо с самой панели, где лежит подписанный релиз канала
// обновлений. Каталог хранится в БД, из кода он не обновится, поэтому чиним запись здесь.
try {
  const row = db.prepare("SELECT data FROM app_clients WHERE id = 'novpn-desktop'").get() as { data: string } | undefined;
  if (row) {
    const app = JSON.parse(row.data) as { platforms?: Array<{ platform: string; url?: string | null }> };
    let changed = false;
    for (const p of app.platforms ?? []) {
      if (typeof p.url === 'string' && /raw\.githubusercontent\.com\/.*\/desktop\/(vpn|novpn)\.exe$/.test(p.url)) {
        p.url = '/desktop/novpn.exe';
        changed = true;
      }
    }
    if (changed) {
      db.prepare("UPDATE app_clients SET data = ? WHERE id = 'novpn-desktop'").run(JSON.stringify(app));
      console.log('[migrate] ссылка на NoVPN Desktop переведена на канал обновлений панели');
    }
  }
} catch {
  /* таблицы ещё нет */
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
