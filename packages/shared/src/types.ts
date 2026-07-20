// Доменные типы NoVPN. Формы совместимы с mock-адаптером фронтенда
// и со схемой backend/API. ISO-строки для дат, id — строки.

import type {
  AgentConnectivity,
  ConfigSource,
  DeviceStatus,
  EndpointReachability,
  JobState,
  ManagementLevel,
  Protocol,
  ProxyType,
  ResetPolicy,
  ServiceHealth,
  TelegramMode,
  UserProtocol,
} from './enums.js';

export interface Server {
  id: string;
  name: string;
  country: string | null;
  host: string;
  /** Агент подключён к панели. */
  agent: AgentConnectivity;
  /** Публичный VPN-endpoint доступен снаружи. */
  endpointOk: boolean;
  /** Здоровье VPN-службы (детальный сигнал). */
  serviceHealth?: ServiceHealth;
  endpointReachability?: EndpointReachability;
  protocols: Protocol[];
  trafficGb: number;
  users: number;
  isDefault: boolean;
  autoIssue: boolean;
  lastSyncAt: string | null;
  recommended: boolean;
  /** Версия установленного агента. */
  agentVersion?: string | null;
}

export interface User {
  id: string;
  name: string;
  comment: string;
  category: string | null;
  tags: string[];
  /** Шестизначный пользовательский код. Устаревший способ входа: работает
   *  только у тех, кому он был разрешён при переходе на ссылки, и только до
   *  codeLoginUntil. Остаётся как идентификатор в Telegram-боте. */
  code: string;
  /** Токен личной ссылки: vpn.appswire.ru/k/<accessToken>. Основной способ входа. */
  accessToken: string | null;
  /** До какого момента этому пользователю разрешён вход по коду.
   *  null = нельзя (так у всех, кого завели после перехода на ссылки). */
  codeLoginUntil: string | null;
  deviceLimit: number | null;
  expiresAt: string | null;
  trafficLimitGb: number | null;
  trafficUsedGb: number;
  resetPolicy: ResetPolicy;
  allowedServers: string[];
  defaultServerId: string | null;
  allowedProtocols: UserProtocol[];
  isActive: boolean;
  telegram: string | null;
  createdAt: string;
  lastActivityAt: string | null;
}

export interface Device {
  id: string;
  userId: string | null;
  /** Ссылка vpn:// для приложения AmneziaVPN (импорт в один тап).
   *  Только у AmneziaWG-устройств; отдельное приложение AmneziaWG её не понимает. */
  vpnKey?: string | null;
  name: string;
  serverId: string;
  protocol: Protocol;
  isActive: boolean;
  lastSeenAt: string | null;
  trafficGb: number;
  createdAt: string;
  /** Подсказка ОС: только заявленная пользователем/платформой, не угаданная. */
  osHint: string | null;
  /** Источник и уровень управления — для импортированных/legacy записей. */
  source?: ConfigSource;
  managementLevel?: ManagementLevel;
  /** Вычисляемый статус для отображения. */
  status?: DeviceStatus;
  /** Мониторинг трафика/активности реально доступен по этому конфигу. */
  monitoringAvailable?: boolean;
  /** Сохранённый конфиг устройства (для повторного просмотра). */
  link?: string | null;
  conf?: string | null;
}

export type AppPlatform = 'Android' | 'iOS' | 'Windows' | 'macOS' | 'Linux';

/** Один клиент на конкретной платформе: ссылка и/или загруженный файл. */
export interface AppPlatformEntry {
  platform: AppPlatform;
  /** Ссылка (стор/сайт/прямая) для этой платформы. */
  url?: string | null;
  /** Загруженный файл (data URL) для этой платформы. */
  file?: string | null;
}

/** Клиент-приложение: одна карточка на все платформы, ссылки/файлы — по платформам. */
export interface AppClient {
  id: string;
  client: string;
  /** С какими форматами совместим: xray | amneziawg | amnezia-app (vpn://). */
  compat: Array<'xray' | 'amneziawg' | 'amnezia-app'>;
  /** Офиц. сайт клиента (общий). */
  source: string;
  instruction: string;
  enabled: boolean;
  /** Иконка клиента (data URL). */
  icon?: string | null;
  /** Платформы, на которых доступен клиент, со ссылками/файлами. */
  platforms: AppPlatformEntry[];
}

export interface TelegramSettings {
  enabled: boolean;
  /** Токен наружу не возвращается — только маска. */
  tokenMasked: string | null;
  mode: TelegramMode;
  proxyOn: boolean;
  /** Источник прокси: взять адрес выбранного сервера или указать вручную. */
  proxySource?: 'server' | 'manual';
  proxyServerId?: string | null;
  proxyType: ProxyType;
  proxyHost: string;
  proxyPort: string;
  proxyLogin: string;
  /** Пароль прокси наружу не возвращается. */
  proxyPassSet?: boolean;
  template: string;
  status: 'running' | 'stopped' | 'error';
  linkedUserIds: string[];
  /** @username бота (узнаётся автоматически) — для ссылки-привязки. */
  botUsername?: string | null;
}

export interface AppSettings {
  appName: string;
  logo: string | null;
  domain: string;
  defaultServerId: string | null;
  defaultProtocols: UserProtocol[];
  messageTemplate: string;
  activeThresholdDays: number;
  ipRetentionDays: number;
  logsRetentionDays: number;
  codeLength: number;
  codeAttempts: number;
  codeCooldownMin: number;
  sessionTtlHours: number;
}

export interface LogEntry {
  at: string;
  text: string;
}

export interface JobError {
  at: string;
  server: string;
  text: string;
}

export interface Job {
  id: string;
  serverId: string;
  type: string;
  state: JobState;
  progress: number;
  createdAt: string;
  updatedAt: string;
  error: string | null;
}

/** Прокси-доступ (HTTP/SOCKS5) — только для администратора. */
export interface ProxyAccess {
  id: string;
  serverId: string;
  type: ProxyType;
  login: string;
  /** Пароль наружу не возвращается после создания. */
  passwordSet: boolean;
  expiresAt: string | null;
  trafficLimitGb: number | null;
  trafficUsedGb: number;
  isActive: boolean;
  createdAt: string;
}

/** Ответ /api/bootstrap — всё, что нужно ПАНЕЛИ АДМИНА при старте. Только для админа:
 *  содержит коды доступа всех пользователей и конфиги всех устройств. */
export interface BootstrapData {
  users: User[];
  devices: Device[];
  servers: Server[];
  apps: AppClient[];
  telegram: TelegramSettings;
  settings: AppSettings;
  adminLog: LogEntry[];
  jobErrors: JobError[];
  history: Record<string, LogEntry[]>;
}

/** Сервер глазами обычного пользователя: куда подключаться, без внутренней телеметрии. */
export interface PublicServerView {
  id: string;
  name: string;
  country: string | null;
  host: string;
  protocols: Protocol[];
  isDefault: boolean;
  recommended: boolean;
  /** Сервер доступен для выпуска конфига. */
  online: boolean;
}

