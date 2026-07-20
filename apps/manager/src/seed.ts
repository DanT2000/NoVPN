// Первичное наполнение: настройки, Telegram, каталог приложений.
// НЕ создаёт демо-пользователей/серверы — они появляются через создание/enrollment.

import type { AppClient, AppSettings, TelegramSettings } from '@novpn/shared';
import { DEFAULT_APPS } from '@novpn/shared';
import { db, getSetting, setSetting } from './db.js';

const DEFAULT_SETTINGS: AppSettings = {
  appName: 'NoVPN',
  logo: null,
  domain: '',
  defaultServerId: null,
  defaultProtocols: ['xray', 'amneziawg'],
  messageTemplate:
    'Ваш доступ NoVPN:\n\n{link}\n\nПерейдите по ссылке — откроется личный кабинет, вводить ничего не нужно. Там подключите устройство и получите конфигурацию.\n\nДействует до: {expires}',
  activeThresholdDays: 7,
  ipRetentionDays: 30,
  logsRetentionDays: 90,
  codeLength: 6,
  codeAttempts: 5,
  codeCooldownMin: 15,
  sessionTtlHours: 24,
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

export function seedIfEmpty(): void {
  if (getSetting<AppSettings | null>('settings', null) == null) setSetting('settings', DEFAULT_SETTINGS);
  if (getSetting<TelegramSettings | null>('telegram', null) == null) setSetting('telegram', DEFAULT_TELEGRAM);

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
