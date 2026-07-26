// Seed-данные для mock-адаптера. Порт mock-data.js под TS-типы.
// Используются ТОЛЬКО mock-адаптером; компоненты их не импортируют.

import type {
  AppSettings,
  Device,
  JobError,
  LogEntry,
  Server,
  TelegramSettings,
  User,
} from '@novpn/shared';
import { DEFAULT_APPS } from '@novpn/shared';

const now = Date.now();
const D = 86400000;
const iso = (t: number) => new Date(t).toISOString();

export const SERVERS: Server[] = [
  { id: 's1', name: 'Нидерланды', country: 'NL', host: 'nl1.novpn.example', agent: 'online', endpointOk: true, protocols: ['xray', 'amneziawg'], trafficGb: 412.7, users: 14, isDefault: true, autoIssue: true, lastSyncAt: iso(now - 4 * 60000), recommended: true },
  { id: 's2', name: 'Германия', country: 'DE', host: 'de1.novpn.example', agent: 'online', endpointOk: true, protocols: ['xray'], trafficGb: 268.1, users: 9, isDefault: false, autoIssue: true, lastSyncAt: iso(now - 11 * 60000), recommended: false },
  { id: 's3', name: 'США', country: 'US', host: 'us1.novpn.example', agent: 'offline', endpointOk: false, protocols: ['xray', 'amneziawg'], trafficGb: 96.4, users: 3, isDefault: false, autoIssue: false, lastSyncAt: iso(now - 26 * 3600000), recommended: false },
];

export const USERS: User[] = [
  { id: 'u1', name: 'Иван', comment: 'Брат', category: 'Семья', tags: ['родные'], code: '482915', accessToken: 'tok-482915', codeLoginUntil: null, deviceLimit: 5, expiresAt: iso(now + 33 * D), trafficLimitGb: 100, trafficUsedGb: 18.4, resetPolicy: 'monthly', allowedServers: ['s1', 's2'], defaultServerId: 's1', allowedProtocols: ['xray', 'amneziawg'], isActive: true, telegram: '@ivan_k', createdAt: iso(now - 60 * D), lastActivityAt: iso(now - 5 * 60000) },
  { id: 'u2', name: 'Мария', comment: '', category: 'Друзья', tags: ['промо'], code: '730114', accessToken: 'tok-730114', codeLoginUntil: null, deviceLimit: 3, expiresAt: iso(now + 3 * D), trafficLimitGb: 10, trafficUsedGb: 9.1, resetPolicy: 'never', allowedServers: ['s1'], defaultServerId: 's1', allowedProtocols: ['xray'], isActive: true, telegram: null, createdAt: iso(now - 27 * D), lastActivityAt: iso(now - 2 * 3600000) },
  { id: 'u3', name: 'Офис-01', comment: 'Общий доступ для офиса', category: 'Работа', tags: ['офис', 'vip'], code: '205871', accessToken: 'tok-205871', codeLoginUntil: null, deviceLimit: null, expiresAt: null, trafficLimitGb: null, trafficUsedGb: 240.8, resetPolicy: 'never', allowedServers: ['s1', 's2', 's3'], defaultServerId: 's2', allowedProtocols: ['xray', 'amneziawg'], isActive: true, telegram: '@office_admin', createdAt: iso(now - 120 * D), lastActivityAt: iso(now - 20 * 60000) },
  { id: 'u4', name: 'Пётр', comment: '', category: 'Друзья', tags: [], code: '664209', accessToken: 'tok-664209', codeLoginUntil: null, deviceLimit: 2, expiresAt: iso(now - 6 * D), trafficLimitGb: 50, trafficUsedGb: 31.2, resetPolicy: 'never', allowedServers: ['s1'], defaultServerId: 's1', allowedProtocols: ['xray', 'amneziawg'], isActive: true, telegram: null, createdAt: iso(now - 90 * D), lastActivityAt: iso(now - 8 * D) },
  { id: 'u5', name: 'Тест', comment: 'Отключён вручную', category: 'Общие', tags: ['тест'], code: '918273', accessToken: 'tok-918273', codeLoginUntil: null, deviceLimit: 1, expiresAt: iso(now + 300 * D), trafficLimitGb: 5, trafficUsedGb: 0.2, resetPolicy: 'never', allowedServers: ['s1'], defaultServerId: 's1', allowedProtocols: ['xray'], isActive: false, telegram: null, createdAt: iso(now - 14 * D), lastActivityAt: null },
  { id: 'u6', name: 'Анна', comment: '', category: 'Семья', tags: [], code: '555001', accessToken: 'tok-555001', codeLoginUntil: null, deviceLimit: 1, expiresAt: iso(now + 12 * D), trafficLimitGb: 20, trafficUsedGb: 20, resetPolicy: 'monthly', allowedServers: ['s1'], defaultServerId: 's1', allowedProtocols: ['xray', 'amneziawg'], isActive: true, telegram: null, createdAt: iso(now - 40 * D), lastActivityAt: iso(now - 3 * D) },
];

export const DEVICES: Device[] = [
  { id: 'd1', userId: 'u1', name: 'Телефон', serverId: 's1', protocol: 'xray', isActive: true, lastSeenAt: iso(now - 5 * 60000), trafficGb: 12.1, createdAt: iso(now - 58 * D), osHint: 'Android (указано пользователем)', source: 'managed', monitoringAvailable: true },
  { id: 'd2', userId: 'u1', name: 'Ноутбук', serverId: 's1', protocol: 'amneziawg', isActive: true, lastSeenAt: iso(now - 3 * D), trafficGb: 6.3, createdAt: iso(now - 30 * D), osHint: null, source: 'managed', monitoringAvailable: true },
  { id: 'd3', userId: 'u2', name: 'Телефон Марии', serverId: 's1', protocol: 'xray', isActive: true, lastSeenAt: iso(now - 2 * 3600000), trafficGb: 9.1, createdAt: iso(now - 27 * D), osHint: 'iOS (указано пользователем)', source: 'managed', monitoringAvailable: true },
  { id: 'd4', userId: 'u3', name: 'Офис-роутер', serverId: 's2', protocol: 'amneziawg', isActive: true, lastSeenAt: iso(now - 20 * 60000), trafficGb: 190.2, createdAt: iso(now - 119 * D), osHint: null, source: 'managed', monitoringAvailable: true },
  { id: 'd5', userId: 'u3', name: 'Рабочий ПК', serverId: 's2', protocol: 'xray', isActive: true, lastSeenAt: null, trafficGb: 0, createdAt: iso(now - 10 * D), osHint: null, source: 'managed', monitoringAvailable: true },
  { id: 'd6', userId: 'u4', name: 'Планшет', serverId: 's1', protocol: 'xray', isActive: false, lastSeenAt: iso(now - 9 * D), trafficGb: 14.6, createdAt: iso(now - 88 * D), osHint: null, source: 'managed', monitoringAvailable: true },
  { id: 'd7', userId: 'u6', name: 'Телефон', serverId: 's1', protocol: 'xray', isActive: true, lastSeenAt: iso(now - 3 * D), trafficGb: 20, createdAt: iso(now - 39 * D), osHint: null, source: 'managed', monitoringAvailable: true },
  // Пример импортированного legacy-конфига без надёжного владельца:
  { id: 'd8', userId: null, name: 'Импортированный доступ', serverId: 's1', protocol: 'amneziawg', isActive: true, lastSeenAt: null, trafficGb: 0, createdAt: iso(now - 200 * D), osHint: null, source: 'unassigned', managementLevel: 'observed', monitoringAvailable: false },
];

export const APPS = DEFAULT_APPS;

export const TELEGRAM: TelegramSettings = {
  enabled: false, tokenMasked: null, mode: 'polling',
  proxyOn: false, proxyType: 'http', proxyHost: '', proxyPort: '', proxyLogin: '', proxyPassSet: false,
  template: 'Ваш доступ NoVPN:\n\n{link}\n\nПерейдите по ссылке — откроется личный кабинет, вводить ничего не нужно.\n\nДействует до: {expires}',
  status: 'stopped', linkedUserIds: ['u1', 'u3'],
};

export const SETTINGS: AppSettings = {
  appName: 'NoVPN', logo: null, domain: 'https://vpn.example.ru',
  defaultServerId: 's1', defaultProtocols: ['xray', 'amneziawg'],
  messageTemplate: 'Ваш доступ NoVPN:\n\n{link}\n\nПерейдите по ссылке — откроется личный кабинет, вводить ничего не нужно. Там подключите устройство и получите конфигурацию.\n\nДействует до: {expires}',
  activeThresholdDays: 7, ipRetentionDays: 30, logsRetentionDays: 90,
  codeLength: 6, codeAttempts: 5, codeCooldownMin: 15, sessionTtlHours: 24, inactiveDisableDays: 0,
};

export const ADMIN_LOG: LogEntry[] = [
  { at: iso(now - 12 * 60000), text: 'Продлён доступ «Мария» на 30 дней' },
  { at: iso(now - 3 * 3600000), text: 'Создан пользователь «Анна»' },
  { at: iso(now - 26 * 3600000), text: 'Отключено устройство «Планшет» (Пётр)' },
  { at: iso(now - 2 * D), text: 'Перевыпущен код для «Тест»' },
];

export const JOB_ERRORS: JobError[] = [
  { at: iso(now - 26 * 3600000), server: 'США', text: 'Агент не отвечает: timeout 10s при синхронизации' },
];

export const HISTORY: Record<string, LogEntry[]> = {
  u1: [
    { at: iso(now - 12 * 60000), text: 'Выпущен конфиг «Телефон» (Xray, Нидерланды)' },
    { at: iso(now - 30 * D), text: 'Выпущен конфиг «Ноутбук» (AmneziaWG)' },
    { at: iso(now - 45 * D), text: 'Продлён на 60 дней' },
    { at: iso(now - 60 * D), text: 'Пользователь создан' },
  ],
};

// ── config builders (только для mock; реальный API отдаёт настоящие) ──
const b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const rnd44 = () => Array.from({ length: 43 }, () => b64[Math.floor(Math.random() * 64)]).join('') + '=';

export function buildVlessLink(uuid: string, server: Server, label: string): string {
  return `vless://${uuid}@${server.host}:443?type=tcp&security=reality&flow=xtls-rprx-vision&pbk=7xhH4bYmB0dQ9nKpLzR2sWvE1cA5uJ8oT3fMxGyDqSk&sid=6ba85179&sni=yahoo.com&fp=chrome#NoVPN-${encodeURIComponent(label)}`;
}

export function buildAwgConf(server: Server, ipOctet: number): string {
  return `[Interface]
PrivateKey = ${rnd44()}
Address = 10.8.1.${ipOctet}/32
DNS = 1.1.1.1, 1.0.0.1
Jc = 4
Jmin = 40
Jmax = 70
S1 = 86
S2 = 97
H1 = 1004746675
H2 = 928473625
H3 = 1719083348
H4 = 1339303396

[Peer]
PublicKey = ${rnd44()}
PresharedKey = ${rnd44()}
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = ${server.host}:51820
PersistentKeepalive = 25`;
}
