// Каталог клиентов по умолчанию. Используется сервером (seed) и фронтендом (mock).
// Иконки — inline SVG (data URL), без внешних запросов.
//
// urlScheme — ссылка «добавить подписку одним нажатием». Указана ТОЛЬКО там,
// где схема подтверждена (docs клиента / открытый конфиг remnawave). Выдуманная
// схема молча не сработает, и человек решит, что сломана подписка.

import type { AppClient } from './types.js';

export const DEFAULT_APPS: AppClient[] = [
  {
    id: 'happ',
    client: 'Happ',
    compat: ['xray'],
    source: 'https://happ.su',
    instruction: 'Установите приложение и нажмите «Добавить подписку» — она подхватится сама.',
    enabled: true,
    urlScheme: 'happ://add/',
    icon: 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2264%22%20height%3D%2264%22%20viewBox%3D%220%200%2064%2064%22%3E%3Crect%20width%3D%2264%22%20height%3D%2264%22%20rx%3D%2215%22%20fill%3D%22%236D4AFF%22%2F%3E%3Cg%20transform%3D%22translate%287%207%29%20scale%281.0000%29%22%3E%3Cpath%20d%3D%22M22.3264%203H12.3611L9.44444%2020.1525L21.3542%208.22034L22.3264%203Z%22%20fill%3D%22%23fff%22%2F%3E%3Cpath%20d%3D%22M10.9028%2020.1525L22.8125%208.22034L20.8681%2021.1469H28.4028L27.9167%2021.6441L20.8681%2028.8531H19.4097V30.5932L7.5%2042.5254L10.9028%2020.1525Z%22%20fill%3D%22%23fff%22%2F%3E%3Cpath%20d%3D%22M41.0417%208.22034L28.8889%2020.1525L31.684%203H41.7708L41.0417%208.22034Z%22%20fill%3D%22%23fff%22%2F%3E%3Cpath%20d%3D%22M30.3472%2020.1525L42.5%208.22034L38.6111%2030.3446L26.9444%2042.5254L29.0104%2028.8531H22.3264L29.6181%2021.1469H30.3472V20.1525Z%22%20fill%3D%22%23fff%22%2F%3E%3Cpath%20d%3D%22M40.0694%2030.3446L28.4028%2042.5254L27.9167%2047H37.8819L40.0694%2030.3446Z%22%20fill%3D%22%23fff%22%2F%3E%3Cpath%20d%3D%22M18.6806%2047H8.47222L8.95833%2042.5254L20.8681%2030.5932L18.6806%2047Z%22%20fill%3D%22%23fff%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E',
    platforms: [
      { platform: 'Android', url: 'https://play.google.com/store/apps/details?id=com.happproxy' },
      { platform: 'iOS', url: 'https://apps.apple.com/ru/app/happ-proxy-utility-plus/id6746188973' },
      { platform: 'Windows', url: 'https://github.com/Happ-proxy/happ-desktop/releases/latest' },
      { platform: 'macOS', url: 'https://apps.apple.com/ru/app/happ-proxy-utility-plus/id6746188973' },
      { platform: 'Linux', url: 'https://happ.su/' },
    ],
  },
  {
    id: 'v2raytun',
    client: 'V2RayTun',
    compat: ['xray'],
    source: 'https://v2raytun.com',
    instruction: 'Установите приложение и нажмите «Добавить подписку».',
    enabled: true,
    urlScheme: 'v2raytun://import/',
    icon: 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2264%22%20height%3D%2264%22%20viewBox%3D%220%200%2064%2064%22%3E%3Crect%20width%3D%2264%22%20height%3D%2264%22%20rx%3D%2215%22%20fill%3D%22%231E88E5%22%2F%3E%3Cg%20transform%3D%22translate%287%207%29%20scale%281.0000%29%22%3E%3Cpath%20d%3D%22M8%2025h13l8-13%208%2026%208-13h13%22%20fill%3D%22%23fff%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E',
    platforms: [
      { platform: 'Android', url: 'https://play.google.com/store/apps/details?id=com.v2raytun.android' },
      { platform: 'iOS', url: 'https://apps.apple.com/app/v2raytun/id6476628951' },
      { platform: 'Windows', url: 'https://v2raytun.com/' },
    ],
  },
  {
    id: 'streisand',
    client: 'Streisand',
    compat: ['xray'],
    source: 'https://apps.apple.com/app/streisand/id6450534064',
    instruction: 'Установите приложение и нажмите «Добавить подписку».',
    enabled: true,
    urlScheme: 'streisand://import/',
    icon: 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2264%22%20height%3D%2264%22%20viewBox%3D%220%200%2064%2064%22%3E%3Crect%20width%3D%2264%22%20height%3D%2264%22%20rx%3D%2215%22%20fill%3D%22%23111827%22%2F%3E%3Cg%20transform%3D%22translate%287%207%29%20scale%281.0000%29%22%3E%3Cpath%20d%3D%22M8%2025h13l8-13%208%2026%208-13h13%22%20fill%3D%22%23fff%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E',
    platforms: [
      { platform: 'iOS', url: 'https://apps.apple.com/ru/app/streisand/id6450534064' },
      { platform: 'macOS', url: 'https://apps.apple.com/ru/app/streisand/id6450534064' },
    ],
  },
  {
    id: 'v2rayng',
    client: 'v2rayNG',
    compat: ['xray'],
    source: 'https://github.com/2dust/v2rayNG',
    instruction: 'Установите приложение и нажмите «Добавить подписку».',
    enabled: true,
    urlScheme: 'v2rayng://install-config?url=',
    icon: 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2264%22%20height%3D%2264%22%20viewBox%3D%220%200%2064%2064%22%3E%3Crect%20width%3D%2264%22%20height%3D%2264%22%20rx%3D%2215%22%20fill%3D%22%230F766E%22%2F%3E%3Cg%20transform%3D%22translate%287%207%29%20scale%281.0000%29%22%3E%3Cpath%20d%3D%22M7.17%208.24503H2V3H15.16V20.9497L34.5475%203H49L7.17%2047V8.24503Z%22%20fill%3D%22%23fff%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E',
    platforms: [
      { platform: 'Android', url: 'https://play.google.com/store/apps/details?id=com.v2ray.ang' },
    ],
  },
  {
    id: 'nekobox',
    client: 'NekoBox',
    compat: ['xray'],
    source: 'https://github.com/MatsuriDayo/NekoBoxForAndroid',
    instruction: 'Установите приложение, затем добавьте подписку по ссылке.',
    enabled: true,
    icon: 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2264%22%20height%3D%2264%22%20viewBox%3D%220%200%2064%2064%22%3E%3Crect%20width%3D%2264%22%20height%3D%2264%22%20rx%3D%2215%22%20fill%3D%22%23374151%22%2F%3E%3Cg%20transform%3D%22translate%287%207%29%20scale%281.0000%29%22%3E%3Cpath%20d%3D%22M12%2014%209%206l9%205a24%2024%200%200%201%2014%200l9-5-3%208a17%2017%200%201%201-26%200Zm7%2012a3%203%200%201%200%200-6%203%203%200%200%200%200%206Zm12%200a3%203%200%201%200%200-6%203%203%200%200%200%200%206Z%22%20fill%3D%22%23fff%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E',
    platforms: [
      { platform: 'Android', url: 'https://github.com/MatsuriDayo/NekoBoxForAndroid/releases' },
      { platform: 'Windows', url: 'https://github.com/MatsuriDayo/nekoray/releases' },
      { platform: 'Linux', url: 'https://github.com/MatsuriDayo/nekoray/releases' },
    ],
  },
  {
    id: 'amneziavpn',
    client: 'AmneziaVPN',
    compat: ['amnezia-app', 'amneziawg'],
    source: 'https://amnezia.org',
    instruction: 'Установите приложение — конфигурация откроется в нём по кнопке.',
    enabled: true,
    icon: 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2264%22%20height%3D%2264%22%20viewBox%3D%220%200%2064%2064%22%3E%3Crect%20width%3D%2264%22%20height%3D%2264%22%20rx%3D%2215%22%20fill%3D%22%230EA5A4%22%2F%3E%3Cg%20transform%3D%22translate%287%207%29%20scale%281.0000%29%22%3E%3Cpath%20d%3D%22M25%204%206%2012v14c0%2011%208%2018%2019%2020%2011-2%2019-9%2019-20V12L25%204Zm0%206%2013%205.5V26c0%208-5%2013-13%2015-8-2-13-7-13-15V15.5L25%2010Z%22%20fill%3D%22%23fff%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E',
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
    source: 'https://amnezia.org',
    instruction: 'Отдельное приложение только для AmneziaWG: импортируйте файл .conf.',
    enabled: true,
    icon: 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2264%22%20height%3D%2264%22%20viewBox%3D%220%200%2064%2064%22%3E%3Crect%20width%3D%2264%22%20height%3D%2264%22%20rx%3D%2215%22%20fill%3D%22%23F59E0B%22%2F%3E%3Cg%20transform%3D%22translate%287%207%29%20scale%281.0000%29%22%3E%3Cpath%20d%3D%22M6%2030c6-14%2012-14%2019%200s13%2014%2019%200M6%2018c6-14%2012-14%2019%200%22%20fill%3D%22%23fff%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E',
    platforms: [
      { platform: 'Android', url: 'https://play.google.com/store/apps/details?id=org.amnezia.awg' },
      { platform: 'iOS', url: 'https://apps.apple.com/app/amneziawg/id6478942365' },
      { platform: 'Windows', url: 'https://amnezia.org/downloads' },
      { platform: 'macOS', url: 'https://amnezia.org/downloads' },
      { platform: 'Linux', url: 'https://amnezia.org/downloads' },
    ],
  },
];
