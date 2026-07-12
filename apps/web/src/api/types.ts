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
  allowedProtocols: Array<'xray' | 'amneziawg' | 'http' | 'https' | 'socks5'>;
  code: string;
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
    | 'expiresAt'
  >
>;

export interface AddServerInput {
  name: string;
  host: string;
  sshPort: number;
  sshUser: string;
  authMethod: 'key' | 'password';
  vpnHost?: string;
  components: Array<'xray' | 'amneziawg' | 'http' | 'https' | 'socks5'>;
  country?: string | null;
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
  getInitialData(): Promise<BootstrapData>;

  // ── public ──
  checkCode(code: string): Promise<CheckCodeResult>;
  issueDevice(req: IssueDeviceRequest): Promise<IssueDeviceResult>;
  reissueDevice(deviceId: string): Promise<IssueDeviceResult>;
  revokeDevice(deviceId: string): Promise<Ok>;
  deleteDevice(deviceId: string): Promise<Ok>;

  // ── admin: auth ──
  adminLogin(login: string, password: string): Promise<{ ok: boolean }>;

  // ── admin: users ──
  createUser(input: CreateUserInput): Promise<User>;
  updateUser(id: string, patch: UpdateUserPatch): Promise<User>;
  extendUser(id: string, days: number): Promise<User>;
  setUserActive(id: string, active: boolean): Promise<User>;
  reissueCode(id: string): Promise<User>;
  setUserCode(id: string, code: string): Promise<CodeResult>;
  deleteUser(id: string): Promise<Ok>;

  // ── admin: servers ──
  testServerConnection(input: AddServerInput): Promise<TestServerConnectionResult>;
  addServer(input: AddServerInput): Promise<Server>;
  editServer(id: string, input: EditServerInput): Promise<Server>;
  installServerProxies(id: string, types: { http: boolean; https: boolean; socks: boolean }): Promise<{ ok: boolean; proxy: ServerProxyConfig; server: Server }>;
  getServerProxy(id: string): Promise<{ proxy: ServerProxyConfig | null; host: string }>;
  provisionServer(id: string, components: string[]): Promise<{ ok: boolean; restored: boolean; proxy: ServerProxyConfig | null; server: Server }>;
  uninstallServer(id: string, purgeKeys?: boolean): Promise<Ok>;
  setServerDefault(id: string): Promise<Server[]>;
  setServerAutoIssue(id: string, on: boolean): Promise<Server>;
  deleteServer(id: string): Promise<Ok>;

  // ── admin: telegram ──
  saveTelegram(input: SaveTelegramInput): Promise<TelegramSettings>;
  testTelegram(token: string): Promise<TestTelegramResult>;

  // ── admin: apps catalog ──
  saveApps(apps: AppClient[]): Promise<AppClient[]>;

  // ── admin: settings ──
  saveSettings(input: AppSettings): Promise<AppSettings>;
}

export type { Device };
