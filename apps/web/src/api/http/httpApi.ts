// HTTP-адаптер: реальный API. Реализует тот же ApiClient, что и mock.
// Пути соответствуют роутам backend (apps/manager). Переключение — в ../index.ts.

import type {
  AppClient,
  AppSettings,
  BootstrapData,
  CheckCodeResult,
  IssueDeviceRequest,
  IssueDeviceResult,
  Server,
  TelegramSettings,
  TestServerConnectionResult,
  TestTelegramResult,
  User,
} from '@novpn/shared';
import type {
  AddServerInput,
  ApiClient,
  CodeResult,
  CreateUserInput,
  EditServerInput,
  Ok,
  SaveTelegramInput,
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
    const message = (data && (data.error?.message || data.message)) || `Ошибка ${res.status}`;
    throw new Error(message);
  }
  return data as T;
}

export const httpApi: ApiClient = {
  getInitialData: () => req<BootstrapData>('GET', '/api/bootstrap'),

  checkCode: (code) => req<CheckCodeResult>('POST', '/api/public/check-code', { code }),
  issueDevice: (r: IssueDeviceRequest) => req<IssueDeviceResult>('POST', '/api/public/devices', r),
  reissueDevice: (id) => req<IssueDeviceResult>('POST', `/api/public/devices/${id}/reissue`),
  revokeDevice: (id) => req<Ok>('POST', `/api/public/devices/${id}/revoke`),
  deleteDevice: (id) => req<Ok>('DELETE', `/api/public/devices/${id}`),

  adminLogin: (login, password) => req<{ ok: boolean }>('POST', '/api/admin/login', { login, password }),

  createUser: (input: CreateUserInput) => req<User>('POST', '/api/admin/users', input),
  updateUser: (id, patch: UpdateUserPatch) => req<User>('PATCH', `/api/admin/users/${id}`, patch),
  extendUser: (id, days) => req<User>('POST', `/api/admin/users/${id}/extend`, { days }),
  setUserActive: (id, active) => req<User>('POST', `/api/admin/users/${id}/active`, { active }),
  reissueCode: (id) => req<User>('POST', `/api/admin/users/${id}/reissue-code`),
  setUserCode: (id, code) => req<CodeResult>('POST', `/api/admin/users/${id}/code`, { code }),
  deleteUser: (id) => req<Ok>('DELETE', `/api/admin/users/${id}`),

  testServerConnection: (input: AddServerInput) =>
    req<TestServerConnectionResult>('POST', '/api/admin/servers/test-ssh', input),
  addServer: (input: AddServerInput) => req<Server>('POST', '/api/admin/servers', input),
  editServer: (id: string, input: EditServerInput) => req<Server>('PATCH', `/api/admin/servers/${id}`, input),
  setServerDefault: (id) => req<Server[]>('POST', `/api/admin/servers/${id}/default`),
  setServerAutoIssue: (id, on) => req<Server>('POST', `/api/admin/servers/${id}/auto-issue`, { on }),
  deleteServer: (id) => req<Ok>('DELETE', `/api/admin/servers/${id}`),

  saveTelegram: (input: SaveTelegramInput) => req<TelegramSettings>('PUT', '/api/admin/telegram', input),
  testTelegram: (token) => req<TestTelegramResult>('POST', '/api/admin/telegram/test', { token }),

  saveApps: (apps: AppClient[]) => req<AppClient[]>('PUT', '/api/admin/apps', { apps }),
  saveSettings: (input: AppSettings) => req<AppSettings>('PUT', '/api/admin/settings', input),
};
