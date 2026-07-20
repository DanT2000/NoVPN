// Mock-адаптер: полностью функциональный in-memory backend для работы фронтенда
// без сервера. Реализует ApiClient. Компоненты его напрямую не видят.

import type {
  AppClient,
  AppSettings,
  BootstrapData,
  CheckCodeResult,
  Device,
  IssueDeviceRequest,
  IssueDeviceResult,
  PublicBootstrapData,
  PublicUserView,
  Server,
  TelegramSettings,
  TestServerConnectionResult,
  TestTelegramResult,
  User,
} from '@novpn/shared';
import type {
  AddServerInput,
  ApiClient,
  CreateUserInput,
  EditServerInput,
  Ok,
  SaveTelegramInput,
  UpdateUserPatch,
} from '../types';
import {
  ADMIN_LOG,
  APPS,
  buildAwgConf,
  buildVlessLink,
  DEVICES,
  HISTORY,
  JOB_ERRORS,
  SERVERS,
  SETTINGS,
  TELEGRAM,
  USERS,
} from './mockData';
import { genUuid } from '../../lib/gen';

const wait = (ms = 300) => new Promise<void>((r) => setTimeout(r, ms));
const clone = <T>(v: T): T => structuredClone(v);

// ── master state (мутируемое) ──
const state = {
  users: clone(USERS),
  devices: clone(DEVICES),
  servers: clone(SERVERS),
  apps: clone(APPS),
  telegram: clone(TELEGRAM),
  settings: clone(SETTINGS),
  adminLog: clone(ADMIN_LOG),
  jobErrors: clone(JOB_ERRORS),
  history: clone(HISTORY),
};

let seq = 1000;
const nextId = (p: string) => `${p}${++seq}`;
const nowIso = () => new Date().toISOString();
const log = (text: string) => state.adminLog.unshift({ at: nowIso(), text });

function toPublic(u: User): PublicUserView {
  return {
    id: u.id, name: u.name, code: u.code, deviceLimit: u.deviceLimit, expiresAt: u.expiresAt,
    trafficLimitGb: u.trafficLimitGb, trafficUsedGb: u.trafficUsedGb, allowedServers: u.allowedServers,
    defaultServerId: u.defaultServerId,
    allowedProtocols: u.allowedProtocols.filter((p): p is 'xray' | 'amneziawg' => p === 'xray' || p === 'amneziawg'),
    isActive: u.isActive, telegramLinked: !!u.telegram, codeLoginUntil: u.codeLoginUntil,
  };
}

function issueConfig(device: Device, server: Server): IssueDeviceResult {
  if (device.protocol === 'xray') {
    const link = buildVlessLink(genUuid(), server, device.name);
    device.link = link;
    device.conf = null;
    return { device, link };
  }
  const conf = buildAwgConf(server, 2 + Math.floor(Math.random() * 250));
  device.conf = conf;
  device.link = null;
  return {
    device,
    conf,
    vpnKeyAvailable: false,
    vpnKeyNote: 'Официальный ключ vpn:// пока недоступен через текущий стек. Используйте .conf в совместимых приложениях.',
  };
}

// Сессия мока: кто вошёл по коду. Повторяет поведение сервера, чтобы
// разработка на моке не расходилась с продом.
let mockUserId: string | null = null;
let mockAdmin = false;

export const mockApi: ApiClient = {
  async getInitialData(): Promise<BootstrapData> {
    await wait(180);
    if (!mockAdmin) throw new Error('Требуется вход администратора.');
    return {
      users: clone(state.users), devices: clone(state.devices), servers: clone(state.servers),
      apps: clone(state.apps), telegram: clone(state.telegram), settings: clone(state.settings),
      adminLog: clone(state.adminLog), jobErrors: clone(state.jobErrors), history: clone(state.history),
    };
  },

  async getPublicData(): Promise<PublicBootstrapData> {
    await wait(120);
    const u = mockUserId ? state.users.find((x) => x.id === mockUserId) ?? null : null;
    return {
      user: u && u.isActive ? toPublic(u) : null,
      devices: u ? clone(state.devices.filter((d) => d.userId === u.id)) : [],
      servers: clone(state.servers).map((s) => ({
        id: s.id, name: s.name, country: s.country, host: s.host, protocols: s.protocols,
        isDefault: s.isDefault, recommended: s.recommended, online: s.agent === 'online' && s.endpointOk,
      })),
      apps: clone(state.apps),
      telegram: { enabled: state.telegram.enabled, botUsername: state.telegram.botUsername ?? null },
      botLink:
        u && state.telegram.enabled && state.telegram.botUsername
          ? `https://t.me/${state.telegram.botUsername}?start=${u.accessToken ?? ''}`
          : null,
      subLink: u ? `https://vpn.example.ru/sub/sub-${u.id}` : null,
    };
  },

  async publicLogout(): Promise<Ok> {
    mockUserId = null;
    return { ok: true };
  },

  async tokenLogin(token: string): Promise<CheckCodeResult> {
    await wait(200);
    const u = state.users.find((x) => x.accessToken === token);
    if (!u) return { error: { type: 'not_found', message: 'Ссылка недействительна. Попросите у администратора новую.' } };
    if (!u.isActive) return { error: { type: 'disabled', message: 'Доступ отключён. Обратитесь к администратору.' } };
    mockUserId = u.id;
    return { user: toPublic(u) };
  },

  async checkCode(code: string): Promise<CheckCodeResult> {
    await wait(450);
    const u = state.users.find((x) => x.code === code);
    if (!u) return { error: { type: 'not_found', message: 'Код не найден. Проверьте правильность ввода.' } };
    if (!u.isActive) return { error: { type: 'disabled', message: 'Доступ отключён. Обратитесь к администратору.' } };
    if (u.expiresAt && new Date(u.expiresAt) < new Date())
      return { error: { type: 'expired', message: 'Срок действия доступа истёк.' } };
    if (u.trafficLimitGb != null && u.trafficUsedGb >= u.trafficLimitGb)
      return { error: { type: 'traffic', message: 'Лимит трафика исчерпан. Обратитесь к администратору.' } };
    if (u.deviceLimit != null) {
      const used = state.devices.filter((d) => d.userId === u.id && d.isActive).length;
      if (used >= u.deviceLimit)
        return { error: { type: 'devices', message: 'Лимит устройств по этому коду исчерпан.' } };
    }
    mockUserId = u.id;
    return { user: toPublic(u) };
  },

  async issueDevice(req: IssueDeviceRequest): Promise<IssueDeviceResult> {
    await wait(650);
    const server = state.servers.find((s) => s.id === req.serverId)!;
    const device: Device = {
      id: nextId('d'), userId: req.userId, name: req.name, serverId: req.serverId, protocol: req.protocol,
      isActive: true, lastSeenAt: null, trafficGb: 0, createdAt: nowIso(), osHint: null,
      source: 'managed', managementLevel: 'managed', monitoringAvailable: true,
    };
    state.devices.push(device);
    return issueConfig(device, server);
  },

  async reissueDevice(deviceId: string): Promise<IssueDeviceResult> {
    await wait(500);
    const device = state.devices.find((d) => d.id === deviceId)!;
    device.isActive = true;
    const server = state.servers.find((s) => s.id === device.serverId)!;
    return issueConfig(device, server);
  },

  async revokeDevice(deviceId: string): Promise<Ok> {
    await wait(300);
    const d = state.devices.find((x) => x.id === deviceId);
    if (d) d.isActive = false;
    return { ok: true };
  },

  async deleteDevice(deviceId: string): Promise<Ok> {
    await wait(300);
    state.devices = state.devices.filter((d) => d.id !== deviceId);
    return { ok: true };
  },

  async adminLogin(password: string): Promise<{ ok: boolean }> {
    await wait(400);
    const ok = password === 'admin';
    if (ok) mockAdmin = true;
    return { ok };
  },

  async adminLogout(): Promise<Ok> {
    mockAdmin = false;
    return { ok: true };
  },
  async changeAdminPassword(_current: string, _next: string): Promise<Ok> {
    await wait(200);
    return { ok: true };
  },
  async restartPanel(): Promise<Ok> {
    await wait(200);
    return { ok: true };
  },

  async exportBackup(_password: string): Promise<Blob> {
    await wait(200);
    return new Blob([JSON.stringify(state, null, 2)], { type: 'application/octet-stream' });
  },
  async restoreBackup(_fileBase64: string, _password: string): Promise<{ ok: boolean; users: number }> {
    await wait(200);
    return { ok: true, users: state.users.length };
  },

  async createUser(input: CreateUserInput): Promise<User> {
    await wait(400);
    const u: User = {
      id: nextId('u'), name: input.name, comment: input.comment ?? '', category: input.category ?? 'Общие',
      tags: input.tags ?? [], code: input.code, deviceLimit: input.deviceLimit, expiresAt: input.expiresAt,
      trafficLimitGb: input.trafficLimitGb, trafficUsedGb: 0, resetPolicy: input.resetPolicy,
      allowedServers: input.allowedServers, defaultServerId: input.defaultServerId,
      allowedProtocols: input.allowedProtocols.filter((p): p is 'xray' | 'amneziawg' => p === 'xray' || p === 'amneziawg'),
      isActive: true, telegram: null, createdAt: nowIso(), lastActivityAt: null,
      // Новым — только личная ссылка: вход по коду для них не открывается.
      accessToken: 'tok-' + Math.random().toString(36).slice(2, 14), codeLoginUntil: null,
    };
    state.users.push(u);
    log(`Создан пользователь «${u.name}»`);
    return clone(u);
  },

  async updateUser(id: string, patch: UpdateUserPatch): Promise<User> {
    await wait(300);
    const u = state.users.find((x) => x.id === id)!;
    Object.assign(u, patch);
    return clone(u);
  },

  async extendUser(id: string, days: number): Promise<User> {
    await wait(300);
    const u = state.users.find((x) => x.id === id)!;
    const base = u.expiresAt && new Date(u.expiresAt) > new Date() ? new Date(u.expiresAt) : new Date();
    u.expiresAt = new Date(base.getTime() + days * 86400000).toISOString();
    log(`Продлён доступ «${u.name}» на ${days} дн`);
    return clone(u);
  },

  async setUserActive(id: string, active: boolean): Promise<User> {
    await wait(300);
    const u = state.users.find((x) => x.id === id)!;
    u.isActive = active;
    if (!active) state.devices.filter((d) => d.userId === id).forEach((d) => (d.isActive = false));
    return clone(u);
  },

  async reissueLink(id: string): Promise<User> {
    await wait(250);
    const u = state.users.find((x) => x.id === id)!;
    u.accessToken = 'tok-' + Math.random().toString(36).slice(2, 14);
    log(`Перевыпущена личная ссылка «${u.name}»`);
    return clone(u);
  },
  async setCodeLogin(id: string, enabled: boolean): Promise<User> {
    await wait(150);
    const u = state.users.find((x) => x.id === id)!;
    u.codeLoginUntil = enabled ? '2999-01-01T00:00:00.000Z' : null;
    return clone(u);
  },

  async reissueCode(id: string): Promise<User> {
    await wait(300);
    const u = state.users.find((x) => x.id === id)!;
    let c: string;
    do {
      c = String(Math.floor(100000 + Math.random() * 900000));
    } while (state.users.some((x) => x.code === c));
    u.code = c;
    log(`Перевыпущен код для «${u.name}»`);
    return clone(u);
  },


  async deleteUser(id: string): Promise<Ok> {
    await wait(300);
    state.users = state.users.filter((u) => u.id !== id);
    state.devices = state.devices.filter((d) => d.userId !== id);
    return { ok: true };
  },

  async testServerConnection(_input: AddServerInput): Promise<TestServerConnectionResult> {
    await wait(1400);
    return {
      ok: true,
      audit: [
        { name: 'SSH-доступ', ok: true, note: 'root@… подключение успешно' },
        { name: 'ОС', ok: true, note: 'Ubuntu 24.04 LTS' },
        { name: 'Docker', ok: true, note: 'v27.1 установлен' },
        { name: 'Xray', ok: false, note: 'не установлен — будет установлен' },
        { name: 'AmneziaWG', ok: false, note: 'не установлен — будет установлен' },
        { name: 'UDP 51820', ok: true, note: 'порт свободен' },
      ],
    };
  },

  async addServer(input: AddServerInput): Promise<Server> {
    await wait(400);
    const s: Server = {
      id: nextId('s'), name: input.name, country: input.country ?? null, host: input.vpnHost || input.host,
      agent: 'online', endpointOk: true,
      protocols: input.components.filter((p): p is 'xray' | 'amneziawg' => p === 'xray' || p === 'amneziawg'),
      trafficGb: 0, users: 0, isDefault: false, autoIssue: true, lastSyncAt: nowIso(), recommended: false,
      agentVersion: '1.0.0',
    };
    state.servers.push(s);
    log(`Добавлен сервер «${s.name}»`);
    return clone(s);
  },

  async editServer(id: string, input: EditServerInput): Promise<Server> {
    await wait(300);
    const s = state.servers.find((x) => x.id === id)!;
    if (input.name !== undefined) s.name = input.name;
    if (input.country !== undefined) s.country = input.country ?? null;
    if (input.vpnHost) s.host = input.vpnHost;
    if (input.components)
      s.protocols = input.components.filter(
        (p): p is 'xray' | 'amneziawg' => p === 'xray' || p === 'amneziawg',
      );
    log(`Изменён сервер «${s.name}»`);
    return clone(s);
  },

  async installServerProxies(id: string, types: { http: boolean; https: boolean; socks: boolean }) {
    await wait(600);
    const s = state.servers.find((x) => x.id === id)!;
    const set = new Set(s.protocols as string[]);
    if (types.http) set.add('http');
    if (types.https) set.add('https');
    if (types.socks) set.add('socks5');
    s.protocols = [...set] as Server['protocols'];
    const proxy = {
      user: 'novpn', pass: 'demo-pass-1234',
      httpPort: types.http || types.https ? 8080 : null,
      httpsPort: types.https ? 8443 : null,
      socksPort: types.socks ? 1080 : null,
      httpsHost: types.https ? s.host : null,
    };
    return { ok: true, proxy, server: clone(s) };
  },
  async getServerProxy(id: string) {
    await wait(150);
    const s = state.servers.find((x) => x.id === id)!;
    return { proxy: null, host: s.host };
  },
  async provisionServer(id: string, components: string[]) {
    await wait(600);
    const s = state.servers.find((x) => x.id === id)!;
    s.protocols = components.filter((p) => ['xray', 'amneziawg', 'http', 'https', 'socks5'].includes(p)) as Server['protocols'];
    s.agent = 'online';
    s.endpointOk = true;
    return { ok: true, running: false };
  },
  async provisionStatus(_id: string) {
    await wait(150);
    return { state: 'done' as const, message: 'Установка завершена.', restored: false };
  },
  async uninstallServer(id: string, _purgeKeys?: boolean): Promise<Ok> {
    await wait(500);
    const s = state.servers.find((x) => x.id === id)!;
    s.agent = 'never';
    s.endpointOk = false;
    s.protocols = [];
    return { ok: true };
  },

  async setServerDefault(id: string): Promise<Server[]> {
    await wait(250);
    state.servers.forEach((s) => (s.isDefault = s.id === id));
    return clone(state.servers);
  },

  async setServerAutoIssue(id: string, on: boolean): Promise<Server> {
    await wait(200);
    const s = state.servers.find((x) => x.id === id)!;
    s.autoIssue = on;
    return clone(s);
  },

  async deleteServer(id: string): Promise<Ok> {
    await wait(250);
    state.servers = state.servers.filter((s) => s.id !== id);
    state.devices = state.devices.filter((d) => d.serverId !== id);
    return { ok: true };
  },

  async saveTelegram(input: SaveTelegramInput): Promise<TelegramSettings> {
    await wait(350);
    const t = state.telegram;
    t.enabled = input.enabled;
    t.mode = input.mode;
    t.proxyOn = input.proxyOn;
    t.proxyType = input.proxyType;
    t.proxyHost = input.proxyHost;
    t.proxyPort = input.proxyPort;
    t.proxyLogin = input.proxyLogin;
    t.template = input.template;
    if (input.token) t.tokenMasked = `••••${input.token.slice(-4)}`;
    if (input.proxyPass) t.proxyPassSet = true;
    t.status = input.enabled ? (t.tokenMasked ? 'running' : 'stopped') : 'stopped';
    return clone(t);
  },

  async testTelegram(token: string): Promise<TestTelegramResult> {
    await wait(1100);
    if (!token || token.length < 10) return { ok: false, message: 'Токен не задан или слишком короткий.' };
    return { ok: true, message: 'Бот @novpn_helper_bot отвечает. Webhook доступен.' };
  },

  async saveApps(apps: AppClient[]): Promise<AppClient[]> {
    await wait(300);
    state.apps = clone(apps);
    return clone(state.apps);
  },

  async saveSettings(input: AppSettings): Promise<AppSettings> {
    await wait(300);
    state.settings = clone(input);
    return clone(state.settings);
  },
};
