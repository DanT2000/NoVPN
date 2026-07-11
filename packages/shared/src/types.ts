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
  /** Шестизначный пользовательский код. */
  code: string;
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

export interface AppClient {
  id: string;
  platform: 'Android' | 'iOS' | 'Windows' | 'macOS' | 'Linux';
  client: string;
  /** С какими форматами совместим: xray | amneziawg | amnezia-app (vpn://). */
  compat: Array<'xray' | 'amneziawg' | 'amnezia-app'>;
  source: string;
  store: string | null;
  version: string;
  localFile: string | null;
  instruction: string;
  enabled: boolean;
  /** Иконка клиента (data URL). */
  icon?: string | null;
  /** Прямая ссылка на скачивание (отдельно от офиц. сайта/стора). */
  downloadUrl?: string | null;
}

export interface TelegramSettings {
  enabled: boolean;
  /** Токен наружу не возвращается — только маска. */
  tokenMasked: string | null;
  mode: TelegramMode;
  proxyOn: boolean;
  proxyType: ProxyType;
  proxyHost: string;
  proxyPort: string;
  proxyLogin: string;
  /** Пароль прокси наружу не возвращается. */
  proxyPassSet?: boolean;
  template: string;
  status: 'running' | 'stopped' | 'error';
  linkedUserIds: string[];
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

/** Ответ /api/bootstrap — всё, что нужно приложению при старте. */
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
