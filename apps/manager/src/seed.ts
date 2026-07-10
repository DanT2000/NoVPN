// Первичное наполнение: настройки, Telegram, каталог приложений.
// НЕ создаёт демо-пользователей/серверы — они появляются через создание/enrollment.

import type { AppSettings, TelegramSettings } from '@novpn/shared';
import { db, getSetting, setSetting } from './db.js';

const DEFAULT_SETTINGS: AppSettings = {
  appName: 'NoVPN',
  logo: null,
  domain: '',
  defaultServerId: null,
  defaultProtocols: ['xray', 'amneziawg'],
  messageTemplate:
    'Ваш доступ NoVPN:\n\nКод: {code}\nСайт: {url}\nДействует до: {expires}\n\nВведите код на сайте — конфигурация выдаётся автоматически.',
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

// Справочный каталог клиентов (совпадает с дизайном).
const DEFAULT_APPS = [
  ['a1', 'Android', 'v2rayNG', ['xray'], 'https://github.com/2dust/v2rayNG', 'Google Play', '1.9.16', null, 'Установите → «+» → «Импорт из буфера» → вставьте ссылку → подключитесь.'],
  ['a2', 'Android', 'AmneziaVPN', ['amnezia-app'], 'https://amnezia.org', 'Google Play', '4.8', null, 'Установите → «Подключение по ключу» → вставьте vpn:// ключ.'],
  ['a3', 'Android', 'AmneziaWG', ['amneziawg'], 'https://github.com/amnezia-vpn/amneziawg-android', 'Google Play', '1.1', null, 'Установите → «+» → «Импорт из файла» или сканируйте QR конфига.'],
  ['a4', 'iOS', 'Happ', ['xray'], 'https://happ.su', 'App Store', '1.14', null, 'Установите → «Добавить подписку/ссылку» → вставьте ссылку.'],
  ['a5', 'iOS', 'AmneziaVPN', ['amnezia-app'], 'https://amnezia.org', 'App Store', '4.8', null, 'Установите → «Подключение по ключу» → вставьте vpn:// ключ.'],
  ['a6', 'iOS', 'AmneziaWG', ['amneziawg'], 'https://apps.apple.com/app/amneziawg', 'App Store', '1.2', null, 'Установите → «+» → импортируйте .conf или QR.'],
  ['a7', 'Windows', 'v2rayN', ['xray'], 'https://github.com/2dust/v2rayN', null, '6.60', 'v2rayN-6.60.zip', 'Распакуйте → «Серверы» → «Импорт из буфера» → вставьте ссылку.'],
  ['a8', 'Windows', 'AmneziaVPN', ['amnezia-app', 'amneziawg'], 'https://amnezia.org', null, '4.8', null, 'Установите → добавьте ключ vpn:// или импортируйте .conf.'],
  ['a9', 'macOS', 'Happ', ['xray'], 'https://happ.su', 'App Store', '1.14', null, 'Установите → «Добавить ссылку» → вставьте ссылку.'],
  ['a10', 'macOS', 'AmneziaVPN', ['amnezia-app', 'amneziawg'], 'https://amnezia.org', null, '4.8', null, 'Установите → добавьте ключ vpn:// или импортируйте .conf.'],
  ['a11', 'Linux', 'NekoRay', ['xray'], 'https://github.com/MatsuriDayo/nekoray', null, '4.0.1', null, 'Установите → «Программа» → «Добавить профиль из буфера».'],
  ['a12', 'Linux', 'AmneziaWG (CLI)', ['amneziawg'], 'https://github.com/amnezia-vpn/amneziawg-linux-kernel-module', null, '—', null, 'Сохраните .conf в /etc/amnezia/amneziawg/ → awg-quick up awg0.'],
  ['a13', 'Windows', 'AmneziaWG', ['amneziawg'], 'https://github.com/amnezia-vpn/amneziawg-windows-client', null, '1.0', 'amneziawg-windows.zip', 'Распакуйте → «Импорт туннеля из файла» → выберите .conf → активируйте.'],
  ['a14', 'macOS', 'AmneziaWG', ['amneziawg'], 'https://apps.apple.com/app/amneziawg', 'App Store', '1.2', null, 'Установите → «+» → импортируйте .conf или сканируйте QR.'],
  ['a15', 'Linux', 'AmneziaVPN', ['amnezia-app', 'amneziawg'], 'https://amnezia.org', null, '4.8', null, 'Установите AppImage → добавьте ключ vpn:// или импортируйте .conf.'],
] as const;

export function seedIfEmpty(): void {
  if (getSetting<AppSettings | null>('settings', null) == null) setSetting('settings', DEFAULT_SETTINGS);
  if (getSetting<TelegramSettings | null>('telegram', null) == null) setSetting('telegram', DEFAULT_TELEGRAM);

  const appCount = (db.prepare('SELECT COUNT(*) AS n FROM apps').get() as { n: number }).n;
  if (appCount === 0) {
    const stmt = db.prepare(
      'INSERT INTO apps(id, platform, client, compat, source, store, version, local_file, instruction, enabled, sort) VALUES(?,?,?,?,?,?,?,?,?,1,?)',
    );
    DEFAULT_APPS.forEach((a, i) => {
      stmt.run(a[0], a[1], a[2], JSON.stringify(a[3]), a[4], a[5], a[6], a[7], a[8], i);
    });
  }
}
