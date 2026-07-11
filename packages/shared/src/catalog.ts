// Готовый каталог клиентов по умолчанию. Используется и сервером (seed),
// и фронтендом (mock). Иконки — inline SVG (data URL), без внешних запросов.

import type { AppClient } from './types.js';

/** Простая иконка: скруглённый квадрат нужного цвета + буква. */
function ic(letter: string, bg: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">` +
    `<rect width="64" height="64" rx="15" fill="${bg}"/>` +
    `<text x="32" y="44" font-family="Arial, sans-serif" font-size="34" font-weight="700" fill="#fff" text-anchor="middle">${letter}</text>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export const DEFAULT_APPS: AppClient[] = [
  {
    id: 'happ',
    client: 'Happ',
    compat: ['xray'],
    source: 'https://happ.su',
    instruction: 'Установите приложение → «+» / «Добавить подписку» → вставьте ссылку или отсканируйте QR → подключитесь.',
    enabled: true,
    icon: ic('H', '#2563eb'),
    platforms: [
      { platform: 'Android', url: 'https://play.google.com/store/apps/details?id=com.happproxy' },
      { platform: 'iOS', url: 'https://apps.apple.com/app/happ-proxy-utility/id6504287215' },
      { platform: 'Windows', url: 'https://happ.su/' },
      { platform: 'macOS', url: 'https://apps.apple.com/app/happ-proxy-utility/id6504287215' },
      { platform: 'Linux', url: 'https://happ.su/' },
    ],
  },
  {
    id: 'amneziavpn',
    client: 'AmneziaVPN',
    compat: ['amnezia-app', 'amneziawg'],
    source: 'https://amnezia.org',
    instruction: 'Установите → импортируйте конфигурацию (файл или ссылку) → подключитесь. Поддерживает AmneziaWG и другие протоколы.',
    enabled: true,
    icon: ic('A', '#16a34a'),
    platforms: [
      { platform: 'Android', url: 'https://play.google.com/store/apps/details?id=org.amnezia.vpn' },
      { platform: 'iOS', url: 'https://apps.apple.com/app/amneziavpn/id1600529900' },
      { platform: 'Windows', url: 'https://amnezia.org/downloads' },
      { platform: 'macOS', url: 'https://amnezia.org/downloads' },
      { platform: 'Linux', url: 'https://amnezia.org/downloads' },
    ],
  },
  {
    id: 'amneziawg',
    client: 'AmneziaWG',
    compat: ['amneziawg'],
    source: 'https://github.com/amnezia-vpn',
    instruction: 'Импортируйте .conf (файл или QR-код) → активируйте туннель.',
    enabled: true,
    icon: ic('W', '#7c3aed'),
    platforms: [
      { platform: 'Android', url: 'https://play.google.com/store/apps/details?id=org.amnezia.awg' },
      { platform: 'iOS', url: 'https://apps.apple.com/app/amneziawg/id6478942365' },
      { platform: 'Windows', url: 'https://github.com/amnezia-vpn/amneziawg-windows-client/releases' },
      { platform: 'macOS', url: 'https://apps.apple.com/app/amneziawg/id6478942365' },
      { platform: 'Linux', url: 'https://github.com/amnezia-vpn/amneziawg-linux-kernel-module' },
    ],
  },
  {
    id: 'v2raytun',
    client: 'V2RayTun',
    compat: ['xray'],
    source: 'https://v2raytun.com',
    instruction: 'Установите → «+» → импорт из буфера или по ссылке → подключитесь.',
    enabled: true,
    icon: ic('V', '#0ea5e9'),
    platforms: [
      { platform: 'Android', url: 'https://play.google.com/store/apps/details?id=com.v2raytun.android' },
      { platform: 'iOS', url: 'https://apps.apple.com/app/v2raytun/id6476628951' },
      { platform: 'Windows', url: 'https://v2raytun.com/' },
    ],
  },
  {
    id: 'v2rayng',
    client: 'v2rayNG',
    compat: ['xray'],
    source: 'https://github.com/2dust/v2rayNG',
    instruction: 'Установите → «+» → «Импорт из буфера» → вставьте ссылку → подключитесь.',
    enabled: true,
    icon: ic('N', '#6366f1'),
    platforms: [
      { platform: 'Android', url: 'https://play.google.com/store/apps/details?id=com.v2ray.ang' },
    ],
  },
  {
    id: 'streisand',
    client: 'Streisand',
    compat: ['xray'],
    source: 'https://apps.apple.com/app/streisand/id6450534064',
    instruction: 'Установите → «+» → вставьте ссылку/подписку → подключитесь.',
    enabled: true,
    icon: ic('S', '#db2777'),
    platforms: [
      { platform: 'iOS', url: 'https://apps.apple.com/app/streisand/id6450534064' },
      { platform: 'macOS', url: 'https://apps.apple.com/app/streisand/id6450534064' },
    ],
  },
  {
    id: 'nekobox',
    client: 'NekoBox / NekoRay',
    compat: ['xray'],
    source: 'https://github.com/MatsuriDayo/nekoray',
    instruction: 'Установите → «Профиль» → «Добавить из буфера» → вставьте ссылку → подключитесь.',
    enabled: true,
    icon: ic('K', '#334155'),
    platforms: [
      { platform: 'Windows', url: 'https://github.com/MatsuriDayo/nekoray/releases' },
      { platform: 'Linux', url: 'https://github.com/MatsuriDayo/nekoray/releases' },
      { platform: 'Android', url: 'https://github.com/MatsuriDayo/NekoBoxForAndroid/releases' },
    ],
  },
];
