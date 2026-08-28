// Первичное наполнение: настройки, Telegram, каталог приложений.
// НЕ создаёт демо-пользователей/серверы — они появляются через создание/enrollment.

import type { AppClient, AppSettings, TelegramSettings } from '@novpn/shared';
import { DEFAULT_APPS } from '@novpn/shared';
import { db, getSetting, setSetting } from './db.js';

const DEFAULT_SETTINGS: AppSettings = {
  domain: '',
  defaultServerId: null,
  defaultProtocols: ['xray', 'amneziawg'],
  messageTemplate:
    'Ваш доступ NoVPN:\n\n{link}\n\nПерейдите по ссылке — откроется личный кабинет, вводить ничего не нужно. Там подключите устройство и получите конфигурацию.\n\nДействует до: {expires}',
  codeAttempts: 5,
  codeCooldownMin: 15,
  inactiveDisableDays: 0,
  codeLoginDays: 15,
  xrayWhitelist: true,
  // whitelistDomains НЕ материализуем: пусто/absent → билдер берёт встроенный
  // RU_WHITELIST_ROUTES и панель продолжает получать обновления списка из кода.
  // Явный список пишется в БД только когда админ реально его отредактирует (#6).
};

const DEFAULT_TELEGRAM: TelegramSettings = {
  enabled: false,
  tokenMasked: null,
  mode: 'polling',
  proxyOn: false,
  proxyType: 'http',
  proxyHost: '',
  proxyPort: '',
  proxyLogin: '',
  proxyPassSet: false,
  template:
    'Ваш доступ NoVPN:\n\n{link}\n\nПерейдите по ссылке — откроется личный кабинет, вводить ничего не нужно.\n\nДействует до: {expires}',
  status: 'stopped',
  linkedUserIds: [],
};

// Три файла умной маршрутизации создаём пустыми валидными контейнерами.
// INSERT OR IGNORE идемпотентен: существующие строки не трогаем.
function seedRoutingFiles(): void {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO routing_files
       (name, content, version, updated_at, root_type, entry_count, mode, source_url, auto_sync, status, status_reason)
     VALUES (?, ?, 1, ?, 'object', 0, 'local', '', 0, 'idle', '')`,
  );
  for (const name of ['upstream', 'apps']) stmt.run(name, '{\n  "items": []\n}', now);
}

export function seedIfEmpty(): void {
  if (getSetting<AppSettings | null>('settings', null) == null) setSetting('settings', DEFAULT_SETTINGS);
  if (getSetting<TelegramSettings | null>('telegram', null) == null) setSetting('telegram', DEFAULT_TELEGRAM);
  seedRoutingFiles();

  const appCount = (db.prepare('SELECT COUNT(*) AS n FROM app_clients').get() as { n: number }).n;
  if (appCount === 0) {
    const stmt = db.prepare('INSERT INTO app_clients(id, sort, data) VALUES(?,?,?)');
    DEFAULT_APPS.forEach((a, i) => stmt.run(a.id, i, JSON.stringify(a)));
    return;
  }

  // Каталог уже засеян раньше — обновляем только то, что задаём мы сами:
  // иконку и схему импорта. Правки администратора (ссылки, тексты, порядок,
  // включённость) не трогаем.
  const rows = db.prepare('SELECT id, data FROM app_clients').all() as Array<{ id: string; data: string }>;

  // Добить новые дефолтные приложения (например NoVPN Desktop), добавленные в каталог
  // после первичного сида. Правки администратора по существующим не трогаем.
  const existingIds = new Set(rows.map((r) => r.id));
  const missing = DEFAULT_APPS.filter((a) => !existingIds.has(a.id));
  if (missing.length) {
    const maxSort = (db.prepare('SELECT COALESCE(MAX(sort), -1) AS m FROM app_clients').get() as { m: number }).m;
    const ins = db.prepare('INSERT INTO app_clients(id, sort, data) VALUES(?,?,?)');
    missing.forEach((a, i) => ins.run(a.id, maxSort + 1 + i, JSON.stringify(a)));
    console.log(`[migrate] добавлены приложения каталога: ${missing.map((a) => a.client).join(', ')}`);
  }

  const upd = db.prepare('UPDATE app_clients SET data = ? WHERE id = ?');
  let changed = 0;
  for (const r of rows) {
    const def = DEFAULT_APPS.find((a) => a.id === r.id);
    if (!def) continue;
    let cur: AppClient;
    try {
      cur = JSON.parse(r.data) as AppClient;
    } catch {
      continue;
    }
    if (cur.icon === def.icon && cur.urlScheme === def.urlScheme) continue;
    upd.run(JSON.stringify({ ...cur, icon: def.icon, urlScheme: def.urlScheme ?? null }), r.id);
    changed++;
  }
  if (changed) console.log(`[migrate] обновлены иконки/схемы импорта у приложений: ${changed}`);
}
