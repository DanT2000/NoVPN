// Первичное наполнение: настройки, Telegram, каталог приложений.
// НЕ создаёт демо-пользователей/серверы — они появляются через создание/enrollment.

import type { AppSettings, TelegramSettings } from '@novpn/shared';
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
    'Ваш доступ NoVPN:\n\nКод: {code}\nСайт: {url}\nДействует до: {expires}\n\nВведите код на сайте и следуйте инструкции.',
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
  }
}
