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
  RoutingCheckResult,
  RoutingFileFull,
  RoutingFileMeta,
  RoutingFileName,
  RoutingSourcePatch,
  AutoRouteState,
  AutoRouteSource,
  AutoRouteSourceInput,
  AutoRouteSourcePatch,
  AutoRouteBuildResult,
  AutoRouteSearchHit,
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

// ── канал обновлений NoVPN Desktop ──
export interface DesktopManifest {
  version: string;
  url?: string;
  sha256: string;
  signature: string;
  sizeBytes: number;
  notes?: string;
  releasedAt?: string;
  channel?: string;
}
export type DesktopMode = 'auto' | 'pin' | 'manual';
export interface DesktopChannelConfig {
  mode: DesktopMode;
  pinnedVersion: string | null;
}
export interface DesktopVersionInfo {
  version: string;
  sizeBytes: number;
  notes?: string;
}
export interface DesktopStatus {
  current: DesktopManifest | null;
  config: DesktopChannelConfig;
  versions: DesktopVersionInfo[];
}
export interface DesktopMirrorResult {
  ok: boolean;
  action: string;
  version?: string;
  error?: string;
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
  /** forever — бессрочно, без автосброса через N дней. */
  setCodeLogin(id: string, enabled: boolean, forever?: boolean): Promise<User>;
  deleteUser(id: string): Promise<Ok>;

  // ── admin: servers ──
  testServerConnection(input: AddServerInput): Promise<TestServerConnectionResult>;
  addServer(input: AddServerInput): Promise<Server>;
  editServer(id: string, input: EditServerInput): Promise<Server>;
  installServerProxies(id: string, types: { http: boolean; https: boolean; socks: boolean }): Promise<{ ok: boolean; proxy: ServerProxyConfig; server: Server }>;
  getServerProxy(id: string): Promise<{ proxy: ServerProxyConfig | null; host: string }>;
  provisionServer(id: string, components: string[], ports?: { portXray?: number; portAwg?: number }, opts?: { migrate?: boolean }): Promise<{ ok: boolean; running: boolean }>;
  provisionStatus(id: string): Promise<{ state: 'idle' | 'running' | 'done' | 'error'; message: string; restored?: boolean }>;
  dnsCheck(id: string): Promise<{ domain: string; resolved: string[]; boxIp: string | null; match: boolean; domainIsIp: boolean }>;
  resyncDevices(id: string): Promise<{ ok: boolean; xray: number; awg: number; message?: string }>;
  uninstallServer(id: string, purgeKeys?: boolean): Promise<Ok>;
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

  // ── admin: канал обновлений NoVPN Desktop ──
  getDesktop(): Promise<DesktopStatus>;
  saveDesktopConfig(patch: Partial<DesktopChannelConfig>): Promise<{
    config: DesktopChannelConfig;
    applied: DesktopMirrorResult;
    current: DesktopManifest | null;
    versions: DesktopVersionInfo[];
  }>;
  uploadDesktopRelease(file: File): Promise<{ ok: boolean; version?: string; current: DesktopManifest | null; versions: DesktopVersionInfo[] }>;
  checkDesktopUpdate(): Promise<DesktopMirrorResult>;

  // ── admin: умная маршрутизация (файлы для NoVPN Desktop) ──
  getRoutingFiles(): Promise<{ files: RoutingFileMeta[] }>;
  getRoutingFile(name: RoutingFileName): Promise<RoutingFileFull>;
  saveRoutingFile(name: RoutingFileName, content: string): Promise<{ meta: RoutingFileMeta; changed: boolean }>;
  saveRoutingSource(name: RoutingFileName, patch: RoutingSourcePatch): Promise<{ meta: RoutingFileMeta }>;
  checkRoutingSource(name: RoutingFileName): Promise<RoutingCheckResult>;

  // AutoRoute: Upstream собирается из многих источников
  getAutoRoute(): Promise<AutoRouteState>;
  addAutoRouteSource(input: AutoRouteSourceInput): Promise<AutoRouteSource>;
  updateAutoRouteSource(id: string, patch: AutoRouteSourcePatch): Promise<AutoRouteSource>;
  deleteAutoRouteSource(id: string): Promise<Ok>;
  reorderAutoRouteSources(ids: string[]): Promise<{ sources: AutoRouteSource[] }>;
  checkAutoRouteSource(id: string): Promise<{ ok: boolean; reason: string; count: number | null; source: AutoRouteSource | null }>;
  buildAutoRoute(opts?: { refresh?: boolean }): Promise<AutoRouteBuildResult>;
  rollbackAutoRoute(version: number): Promise<{ ok: boolean; reason: string }>;
  searchAutoRoute(q: string): Promise<{ query: string; hits: AutoRouteSearchHit[] }>;

  // ── admin: графики истории + здоровье серверов ──
  getStats(days: number): Promise<{ days: number; series: StatsPoint[] }>;
  getHealth(): Promise<{ servers: ServerHealth[] }>;
  /** Расход с разбивкой «кто израсходовал» за час/день/диапазон (опционально по серверу).
   *  from/to — час (YYYY-MM-DDTHH) или день (YYYY-MM-DD); by — группировка ряда. */
  getTraffic(p: { from?: string; to?: string; serverId?: string | null; by?: 'hour' | 'day' }): Promise<TrafficBreakdown>;
  /** Ряд нагрузки одного сервера (ЦП/ОЗУ/диск/сеть) за последние N часов. */
  getServerMetrics(id: string, hours: number): Promise<{ serverId: string; name: string; hours: number; series: ServerMetricPoint[] }>;
  /** Есть ли новая версия панели на GitHub. */
  getPanelUpdate(): Promise<PanelUpdateState>;
  /** Запустить обновление панели (панель перезапустится). */
  runPanelUpdate(): Promise<{ ok: boolean; status: number; version: string }>;
}

/** Точка ряда нагрузки сервера. Скорость сети уже посчитана (байт/с). */
export interface ServerMetricPoint {
  at: string;
  cpuPct: number;
  memUsed: number;
  memTotal: number;
  diskUsed: number;
  diskTotal: number;
  uptimeSec: number;
  netRxBps: number;
  netTxBps: number;
}

/** Состояние обновления панели. */
export interface PanelUpdateState {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  /** Настроен ли хук пересборки — без него обновиться нельзя. */
  hookConfigured: boolean;
  checkedAt: string;
  error?: string;
}

/** Расход за период: суточный ряд + кто именно израсходовал. */
export interface TrafficBreakdown {
  from: string;
  to: string;
  by: 'hour' | 'day';
  serverId: string | null;
  /** С какого часа копятся подробности (null — данных ещё нет). */
  since: string | null;
  keepDays: number;
  /** key — час (YYYY-MM-DDTHH) или день (YYYY-MM-DD), смотря по `by`. */
  series: Array<{ key: string; bytes: number }>;
  who: Array<{
    userId: string | null;
    userName: string;
    bytes: number;
    devices: Array<{ deviceId: string; name: string; protocol: string; serverName: string; bytes: number }>;
  }>;
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
  /** Совместимость: false ⇔ сервер выдаёт только полный туннель. */
  xrayWhitelist: boolean;
  /** 'both' — умная маршрутизация включена (умный + полный профили), 'full' — только полный. */
  profiles: 'both' | 'full' | 'smart';
  /** Направление умного профиля: список → VPN (основной) или список → напрямую (унаследованный). */
  smartDirection: 'match-vpn' | 'match-direct';
  /** Откуда список умного профиля: сборка AutoRoute или только свой список. */
  smartSource: 'autoroute' | 'local';
  whitelistDomains: string[] | undefined;
  lanAccess: boolean;
  /** Подмена DNS в умном профиле: домен восстанавливается даже когда его не видно
   *  в трафике (ECH, не-HTTP протоколы). По умолчанию выключено. */
  fakeDns: boolean;
  /** Через сколько часов полный VPN сам вернётся на умный. 0 — не возвращать. */
  fullTimeoutHours: number;
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
  /** Последний снимок нагрузки (null — ещё не собирали). */
  load: ServerLoad | null;
}

export interface ServerLoad {
  at: string;
  cpuPct: number;
  memUsed: number;
  memTotal: number;
  diskUsed: number;
  diskTotal: number;
  uptimeSec: number;
  /** Сеть: сейчас и пик за сутки (байт/с) — видно, доходят ли всплески до потолка канала. */
  net: { rxBps: number; txBps: number; peakRxBps: number; peakTxBps: number };
}

export type { Device };
