// HTTP-адаптер: реальный API. Реализует тот же ApiClient, что и mock.
// Пути соответствуют роутам backend (apps/manager). Переключение — в ../index.ts.

import type {
  AppClient,
  AppSettings,
  BootstrapData,
  CheckCodeResult,
  Device,
  IssueDeviceRequest,
  IssueDeviceResult,
  ProxyAccount,
  PublicBootstrapData,
  RoutingCheckResult,
  RoutingFileFull,
  RoutingFileMeta,
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
  DesktopChannelConfig,
  DesktopManifest,
  DesktopMirrorResult,
  DesktopStatus,
  DesktopVersionInfo,
  EditServerInput,
  Ok,
  SaveTelegramInput,
  ServerHealth,
  ServerProxyConfig,
  StatsPoint,
  TrafficBreakdown,
  PanelUpdateState,
  ServerMetricPoint,
  UpdateUserPatch,
} from '../types';

const BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    // Протухла админ-сессия → не показываем «дохлую» ошибку, а мягко разлогиниваем
    // (AppStore ловит событие и показывает экран входа).
    if (res.status === 401 && typeof window !== 'undefined' && (path.startsWith('/api/admin') || path === '/api/bootstrap')) {
      window.dispatchEvent(new Event('novpn:auth-expired'));
    }
    const message = (data && (data.error?.message || data.message)) || `Ошибка ${res.status}`;
    throw new Error(message);
  }
  return data as T;
}

export const httpApi: ApiClient = {
  getInitialData: () => req<BootstrapData>('GET', '/api/bootstrap'),
  getPublicData: () => req<PublicBootstrapData>('GET', '/api/public/bootstrap'),

  checkCode: (code) => req<CheckCodeResult>('POST', '/api/public/check-code', { code }),
  tokenLogin: (token) => req<CheckCodeResult>('POST', '/api/public/token-login', { token }),
  publicLogout: () => req<Ok>('POST', '/api/public/logout'),
  issueDevice: (r: IssueDeviceRequest) => req<IssueDeviceResult>('POST', '/api/public/devices', r),
  reissueDevice: (id) => req<IssueDeviceResult>('POST', `/api/public/devices/${id}/reissue`),
  revokeDevice: (id) => req<Ok>('POST', `/api/public/devices/${id}/revoke`),
  deleteDevice: (id) => req<{ ok: boolean; pending?: boolean; message?: string }>('DELETE', `/api/public/devices/${id}`),
  renameDevice: (id, name) => req<Device>('POST', `/api/public/devices/${id}/rename`, { name }),
  cleanupDevices: (ids) => req<{ deleted: number; kept?: number; keptIds?: string[] }>('POST', '/api/public/devices/cleanup', { ids }),

  adminLogin: (password) => req<{ ok: boolean; mustChangePassword?: boolean }>('POST', '/api/admin/login', { password }),
  adminLogout: () => req<Ok>('POST', '/api/admin/logout'),
  changeAdminPassword: (current, next) => req<Ok>('POST', '/api/admin/password', { current, next }),
  restartPanel: () => req<Ok>('POST', '/api/admin/restart'),
  broadcast: (text) => req<{ total: number; sent: number; failed: number }>('POST', '/api/admin/broadcast', { text }),
  issueProxy: (serverId, userId) => req<ProxyAccount>('POST', '/api/public/proxy', { serverId, userId }),
  revokeProxyAccount: (id) => req<Ok>('POST', `/api/public/proxy/${id}/revoke`),

  exportBackup: async (password) => {
    const res = await fetch(`${BASE}/api/admin/backup/export`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      const t = await res.text();
      let msg = `Ошибка ${res.status}`;
      try { msg = JSON.parse(t).error?.message || msg; } catch {}
      throw new Error(msg);
    }
    return res.blob();
  },
  restoreBackup: (fileBase64, password) =>
    req<{ ok: boolean; users: number }>('POST', '/api/admin/backup/restore', { file: fileBase64, password }),

  createUser: (input: CreateUserInput) => req<User>('POST', '/api/admin/users', input),
  updateUser: (id, patch: UpdateUserPatch) => req<User>('PATCH', `/api/admin/users/${id}`, patch),
  extendUser: (id, days) => req<User>('POST', `/api/admin/users/${id}/extend`, { days }),
  setUserActive: (id, active) => req<User>('POST', `/api/admin/users/${id}/active`, { active }),
  reissueCode: (id) => req<User>('POST', `/api/admin/users/${id}/reissue-code`),
  setCode: (id, code) => req<User>('POST', `/api/admin/users/${id}/code`, { code }),
  reissueLink: (id) => req<User>('POST', `/api/admin/users/${id}/reissue-link`),
  setCodeLogin: (id, enabled, forever) => req<User>('POST', `/api/admin/users/${id}/code-login`, { enabled, forever: !!forever }),
  deleteUser: (id) => req<Ok>('DELETE', `/api/admin/users/${id}`),

  testServerConnection: (input: AddServerInput) =>
    req<TestServerConnectionResult>('POST', '/api/admin/servers/test-ssh', input),
  addServer: (input: AddServerInput) => req<Server>('POST', '/api/admin/servers', input),
  editServer: (id: string, input: EditServerInput) => req<Server>('PATCH', `/api/admin/servers/${id}`, input),
  installServerProxies: (id: string, types: { http: boolean; https: boolean; socks: boolean }) =>
    req<{ ok: boolean; proxy: ServerProxyConfig; server: Server }>('POST', `/api/admin/servers/${id}/install-proxies`, types),
  getServerProxy: (id: string) => req<{ proxy: ServerProxyConfig | null; host: string }>('GET', `/api/admin/servers/${id}/proxy`),
  provisionServer: (id: string, components: string[], ports?: { portXray?: number; portAwg?: number }, opts?: { migrate?: boolean }) =>
    req<{ ok: boolean; running: boolean }>('POST', `/api/admin/servers/${id}/provision`, { components, ...ports, ...(opts?.migrate ? { migrate: true } : {}) }),
  provisionStatus: (id: string) =>
    req<{ state: 'idle' | 'running' | 'done' | 'error'; message: string; restored?: boolean }>('GET', `/api/admin/servers/${id}/provision-status`),
  resyncDevices: (id: string) =>
    req<{ ok: boolean; xray: number; awg: number; message?: string }>('POST', `/api/admin/servers/${id}/resync-devices`),
  dnsCheck: (id: string) =>
    req<{ domain: string; resolved: string[]; boxIp: string | null; match: boolean; domainIsIp: boolean }>('GET', `/api/admin/servers/${id}/dns-check`),
  uninstallServer: (id: string, purgeKeys?: boolean) => req<Ok>('POST', `/api/admin/servers/${id}/uninstall`, { purgeKeys: !!purgeKeys }),
  setServerAutoIssue: (id, on) => req<Server>('POST', `/api/admin/servers/${id}/auto-issue`, { on }),
  deleteServer: (id, purgeEndpoint?: boolean) => req<Ok>('DELETE', `/api/admin/servers/${id}`, { purgeEndpoint: !!purgeEndpoint }),
  getEndpointProfile: (host: string) => req<{ profile: import('../types').EndpointProfileView; config: import('../types').EndpointConfigView }>('GET', `/api/admin/endpoint-profile?host=${encodeURIComponent(host)}`),
  saveEndpointConfig: (id: string, patch) => req<{ ok: boolean; config: import('../types').EndpointConfigView }>('PUT', `/api/admin/servers/${id}/endpoint-config`, patch),
  changeServerPort: (id, component, port, keepLegacy) => req<{ ok: boolean; oldPort?: number; newPort?: number; legacyKept?: boolean }>('POST', `/api/admin/servers/${id}/change-port`, { component, port, keepLegacy }),
  disableLegacyPort: (id, proto, port) => req<Ok>('POST', `/api/admin/servers/${id}/disable-legacy`, { proto, port }),
  hardenServerSsh: (id, privateKey) => req<{ ok: boolean; publicKey?: string }>('POST', `/api/admin/servers/${id}/harden-ssh`, { privateKey }),

  saveTelegram: (input: SaveTelegramInput) => req<TelegramSettings>('PUT', '/api/admin/telegram', input),
  testTelegram: (token) => req<TestTelegramResult>('POST', '/api/admin/telegram/test', { token }),

  saveApps: (apps: AppClient[]) => req<AppClient[]>('PUT', '/api/admin/apps', { apps }),
  uploadAppFile: async (appId, platform, file) => {
    // Стримим файл как есть (octet-stream) — без base64, без лимита памяти/размера.
    const res = await fetch(`${BASE}/api/admin/apps/${appId}/${encodeURIComponent(platform)}/file?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      credentials: 'include',
      body: file,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error((data && (data.error?.message || data.message)) || `Ошибка ${res.status}`);
    return data as AppClient;
  },
  deleteAppFile: (appId, platform) => req<AppClient>('DELETE', `/api/admin/apps/${appId}/${encodeURIComponent(platform)}/file`),
  saveSettings: (input: AppSettings) => req<AppSettings>('PUT', '/api/admin/settings', input),
  getStats: (days: number) => req<{ days: number; series: StatsPoint[] }>('GET', `/api/admin/stats?days=${days}`),
  getHealth: () => req<{ servers: ServerHealth[] }>('GET', '/api/admin/health'),
  getTraffic: (p) => {
    const q = new URLSearchParams();
    if (p.from) q.set('from', p.from);
    if (p.to) q.set('to', p.to);
    if (p.serverId) q.set('serverId', p.serverId);
    if (p.by) q.set('by', p.by);
    return req<TrafficBreakdown>('GET', `/api/admin/traffic?${q.toString()}`);
  },
  getServerMetrics: (id, hours) =>
    req<{ serverId: string; name: string; hours: number; series: ServerMetricPoint[] }>('GET', `/api/admin/servers/${id}/metrics?hours=${hours}`),
  getPanelUpdate: () => req<PanelUpdateState>('GET', '/api/admin/panel/update'),
  runPanelUpdate: () => req<{ ok: boolean; status: number; version: string }>('POST', '/api/admin/panel/update'),

  getDesktop: () => req<DesktopStatus>('GET', '/api/admin/desktop'),
  saveDesktopConfig: (patch) =>
    req<{ config: DesktopChannelConfig; applied: DesktopMirrorResult; current: DesktopManifest | null; versions: DesktopVersionInfo[] }>(
      'PUT',
      '/api/admin/desktop/config',
      patch,
    ),
  checkDesktopUpdate: () => req<DesktopMirrorResult>('POST', '/api/admin/desktop/check'),
  uploadDesktopRelease: async (file) => {
    // Сырой zip телом (application/zip); backend читает express.raw.
    const res = await fetch(`${BASE}/api/admin/desktop/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      credentials: 'include',
      body: file,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error((data && (data.error?.message || data.message)) || `Ошибка ${res.status}`);
    return data as { ok: boolean; version?: string; current: DesktopManifest | null; versions: DesktopVersionInfo[] };
  },

  getRoutingFiles: () => req<{ files: RoutingFileMeta[] }>('GET', '/api/admin/routing'),
  getRoutingFile: (name) => req<RoutingFileFull>('GET', `/api/admin/routing/${name}`),
  saveRoutingFile: (name, content) =>
    req<{ meta: RoutingFileMeta; changed: boolean }>('PUT', `/api/admin/routing/${name}`, { content }),
  saveRoutingSource: (name, patch) => req<{ meta: RoutingFileMeta }>('PUT', `/api/admin/routing/${name}/source`, patch),
  checkRoutingSource: (name) => req<RoutingCheckResult>('POST', `/api/admin/routing/${name}/check`),

  getAutoRoute: () => req<import('@novpn/shared').AutoRouteState>('GET', '/api/admin/autoroute'),
  addAutoRouteSource: (input) => req<import('@novpn/shared').AutoRouteSource>('POST', '/api/admin/autoroute/sources', input),
  updateAutoRouteSource: (id, patch) =>
    req<import('@novpn/shared').AutoRouteSource>('PATCH', `/api/admin/autoroute/sources/${id}`, patch),
  deleteAutoRouteSource: (id) => req<Ok>('DELETE', `/api/admin/autoroute/sources/${id}`),
  reorderAutoRouteSources: (ids) =>
    req<{ sources: import('@novpn/shared').AutoRouteSource[] }>('POST', '/api/admin/autoroute/sources/reorder', { ids }),
  checkAutoRouteSource: (id) =>
    req<{ ok: boolean; reason: string; count: number | null; source: import('@novpn/shared').AutoRouteSource | null }>(
      'POST',
      `/api/admin/autoroute/sources/${id}/check`,
    ),
  buildAutoRoute: (opts) => req<import('@novpn/shared').AutoRouteBuildResult>('POST', '/api/admin/autoroute/build', opts ?? {}),
  rollbackAutoRoute: (version) => req<{ ok: boolean; reason: string }>('POST', '/api/admin/autoroute/rollback', { version }),
  searchAutoRoute: (q) =>
    req<{ query: string; hits: import('@novpn/shared').AutoRouteSearchHit[] }>('GET', `/api/admin/autoroute/search?q=${encodeURIComponent(q)}`),
};
