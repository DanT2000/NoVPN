// Единый контракт доступа к данным. Компоненты и store зависят ТОЛЬКО от него.
// Две реализации: mock (in-memory) и http (реальный API). Переключение — в index.ts.

import type {
  AppClient,
  AppSettings,
  BootstrapData,
  CheckCodeResult,
  Device,
  IssueDeviceRequest,
  IssueDeviceResult,
  ProxyAccount,
  ProxyType,
  PublicBootstrapData,
  Server,
  TelegramSettings,
  TestServerConnectionResult,
  TestTelegramResult,
  User,
} from '@novpn/shared';

export interface CreateUserInput {
  name: string;
  comment?: string;
  category?: string | null;
  tags?: string[];
  deviceLimit: number | null;
  expiresAt: string | null;
  trafficLimitGb: number | null;
  resetPolicy: 'never' | 'monthly';
  allowedServers: string[];
  defaultServerId: string | null;
  allowedProtocols: Array<'xray' | 'amneziawg'>;
  /** Типы прокси, которые пользователь может себе выдать (если установлены на сервере). */
  allowedProxies?: ProxyType[];
  /** Код доступа. Пустая строка — сервер сгенерирует сам (код это внутренний
   *  идентификатор, вводить его человеку не нужно). */
  code: string;
  /** Разрешить запасной вход по коду. По умолчанию нет — основной способ ссылка. */
  codeLoginEnabled?: boolean;
}

export type UpdateUserPatch = Partial<
  Pick<
    User,
    | 'name'
    | 'comment'
    | 'category'
    | 'tags'
    | 'deviceLimit'
    | 'trafficLimitGb'
    | 'resetPolicy'
    | 'allowedServers'
    | 'defaultServerId'
    | 'allowedProtocols'
    | 'allowedProxies'
    | 'expiresAt'
  >
>;

export interface AddServerInput {
  name: string;
  host: string;
  sshPort: number;
  sshUser: string;
  authMethod: 'key' | 'password';
  /** Пароль ИЛИ приватный ключ — без него панель не сможет управлять сервером. */
  secret?: string;
  vpnHost?: string;
  components: Array<'xray' | 'amneziawg' | 'http' | 'https' | 'socks5'>;
  country?: string | null;
  flagEmoji?: string | null;
}

export interface ServerProxyConfig {
  user: string;
  pass: string;
  httpPort?: number | null;
  httpsPort?: number | null;
  socksPort?: number | null;
  httpsHost?: string | null;
}

export interface EditServerInput {
  name?: string;
  country?: string | null;
  flagEmoji?: string | null;
  vpnHost?: string;
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  authMethod?: 'key' | 'password';
  secret?: string;
  components?: Array<'xray' | 'amneziawg' | 'http' | 'https' | 'socks5'>;
  serverKeys?: {
    xrayRealityPubKey?: string;
    xrayShortId?: string;
    xraySni?: string;
    awgServerPubKey?: string;
  };
}

export interface SaveTelegramInput {
  enabled: boolean;
  token?: string; // если задан — заменяет; иначе не трогаем
  mode: 'polling' | 'webhook';
  proxyOn: boolean;
  proxySource?: 'server' | 'manual';
  proxyServerId?: string | null;
  proxyType: 'http' | 'https' | 'socks5';
  proxyHost: string;
  proxyPort: string;
  proxyLogin: string;
  proxyPass?: string;
  template: string;
}

export type Ok = { ok: true };
export type CodeResult = { user: User } | { error: { type: string; message: string } };

export interface ApiClient {
  // ── bootstrap ──
  /** Полные данные панели. Требует сессии админа (иначе 401). */
  getInitialData(): Promise<BootstrapData>;
  /** Данные публичной части: справочники + свои устройства по сессии. */
  getPublicData(): Promise<PublicBootstrapData>;

  // ── public ──
  checkCode(code: string): Promise<CheckCodeResult>;
  /** Вход по личной ссылке /k/<токен>. */
  tokenLogin(token: string): Promise<CheckCodeResult>;
  publicLogout(): Promise<Ok>;
  issueDevice(req: IssueDeviceRequest): Promise<IssueDeviceResult>;
  reissueDevice(deviceId: string): Promise<IssueDeviceResult>;
  revokeDevice(deviceId: string): Promise<Ok>;
  deleteDevice(deviceId: string): Promise<{ ok: boolean; pending?: boolean; message?: string }>;
  /** Переименовать конфиг (пользователь или админ). */
  renameDevice(deviceId: string, name: string): Promise<Device>;
  /** Массовая очистка: отозвать на сервере и удалить выбранные конфиги. */
  cleanupDevices(ids: string[]): Promise<{ deleted: number; kept?: number; keptIds?: string[] }>;
  /** Выдать/получить прокси-аккаунт на сервере (для текущего пользователя; админ
   *  может передать userId, чтобы выдать за пользователя). */
  issueProxy(serverId: string, userId?: string): Promise<ProxyAccount>;
  /** Отозвать прокси-аккаунт (удаляет логин на сервере). */
  revokeProxyAccount(id: string): Promise<Ok>;

  // ── admin: auth ──
  adminLogin(password: string): Promise<{ ok: boolean; mustChangePassword?: boolean }>;
  adminLogout(): Promise<Ok>;
  /** Сменить пароль администратора. */
  changeAdminPassword(current: string, next: string): Promise<Ok>;
  /** Перезапустить панель (после смены домена и т.п.). */
  restartPanel(): Promise<Ok>;
  /** Экстренная рассылка через бота всем привязанным пользователям. */
  broadcast(text: string): Promise<{ total: number; sent: number; failed: number }>;
  /** Скачать зашифрованный паролем бэкап базы. */
  exportBackup(password: string): Promise<Blob>;
  /** Восстановить базу из бэкапа (base64) — панель перезапустится. */
  restoreBackup(fileBase64: string, password: string): Promise<{ ok: boolean; users: number }>;

  // ── admin: users ──
  createUser(input: CreateUserInput): Promise<User>;
  updateUser(id: string, patch: UpdateUserPatch): Promise<User>;
  extendUser(id: string, days: number): Promise<User>;
  setUserActive(id: string, active: boolean): Promise<User>;
  reissueCode(id: string): Promise<User>;
  /** Задать пользователю СВОЙ код (6 цифр). Уникальность проверяет сервер. */
  setCode(id: string, code: string): Promise<User>;
  /** Выдать новую личную ссылку — старая сразу перестаёт работать. */
  reissueLink(id: string): Promise<User>;
  /** Включить/выключить запасной вход по коду. */
  setCodeLogin(id: string, enabled: boolean): Promise<User>;
  deleteUser(id: string): Promise<Ok>;

  // ── admin: servers ──
  testServerConnection(input: AddServerInput): Promise<TestServerConnectionResult>;
  addServer(input: AddServerInput): Promise<Server>;
  editServer(id: string, input: EditServerInput): Promise<Server>;
  installServerProxies(id: string, types: { http: boolean; https: boolean; socks: boolean }): Promise<{ ok: boolean; proxy: ServerProxyConfig; server: Server }>;
  getServerProxy(id: string): Promise<{ proxy: ServerProxyConfig | null; host: string }>;
  provisionServer(id: string, components: string[], ports?: { portXray?: number; portAwg?: number }): Promise<{ ok: boolean; running: boolean }>;
  provisionStatus(id: string): Promise<{ state: 'idle' | 'running' | 'done' | 'error'; message: string; restored?: boolean }>;
  uninstallServer(id: string, purgeKeys?: boolean): Promise<Ok>;
  setServerDefault(id: string): Promise<Server[]>;
  setServerAutoIssue(id: string, on: boolean): Promise<Server>;
  deleteServer(id: string, purgeEndpoint?: boolean): Promise<Ok>;

  // ── admin: endpoint profile (порты + пер-серверные настройки конфига) ──
  getEndpointProfile(host: string): Promise<{ profile: EndpointProfileView; config: EndpointConfigView }>;
  saveEndpointConfig(id: string, patch: Partial<EndpointConfigView>): Promise<{ ok: boolean; config: EndpointConfigView }>;
  changeServerPort(id: string, component: 'xray' | 'awg', port: number, keepLegacy: boolean): Promise<{ ok: boolean; oldPort?: number; newPort?: number; legacyKept?: boolean }>;
  disableLegacyPort(id: string, proto: 'xray' | 'awg', port: number): Promise<Ok>;
  hardenServerSsh(id: string, privateKey: string): Promise<{ ok: boolean; publicKey?: string }>;

  // ── admin: telegram ──
  saveTelegram(input: SaveTelegramInput): Promise<TelegramSettings>;
  testTelegram(token: string): Promise<TestTelegramResult>;

  // ── admin: apps catalog ──
  saveApps(apps: AppClient[]): Promise<AppClient[]>;
  /** Стрим-загрузка файла приложения на диск сервера (APK/EXE/AppImage). */
  uploadAppFile(appId: string, platform: string, file: File): Promise<AppClient>;
  /** Снять файл с платформы (удалить с диска). */
  deleteAppFile(appId: string, platform: string): Promise<AppClient>;

  // ── admin: settings ──
  saveSettings(input: AppSettings): Promise<AppSettings>;

  // ── admin: графики истории + здоровье серверов ──
  getStats(days: number): Promise<{ days: number; series: StatsPoint[] }>;
  getHealth(): Promise<{ servers: ServerHealth[] }>;
}

export interface StatsPoint {
  at: string;
  trafficGb: number; // накопительный суммарный трафик на момент снимка
  activeUsers: number;
  activeDevices: number;
  usedDevices: number; // реально используемые (на связи за ~сутки)
  onlineServers: number;
  totalServers: number;
}

export interface EndpointProfileView {
  exists: boolean;
  ports: { xray: number; awg: number; http: number; socks: number; https: number };
  legacyPorts: Array<{ proto: 'xray' | 'awg' | 'http' | 'socks' | 'https'; port: number; target: number; since: string }>;
  hasXrayKeys: boolean;
  hasAwgKeys: boolean;
  updatedAt: string | null;
}

export interface EndpointConfigView {
  xrayWhitelist: boolean;
  whitelistDomains: string[] | undefined;
  lanAccess: boolean;
  fallbackTypes: Array<'https' | 'http' | 'socks'> | null;
}

export interface ServerHealth {
  id: string;
  name: string;
  country: string | null;
  online: boolean;
  lastSyncAt: string | null;
  endpointOk: boolean;
  uptime24h: number;
  uptime7d: number;
  lastChangeAt: string | null;
}

export type { Device };
