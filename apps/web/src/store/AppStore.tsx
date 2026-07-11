// Центральный store: данные, навигация, вход администратора, toast, confirm.
// Экраны зависят только от useApp(). Все мутации идут через api-адаптер.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppClient,
  AppSettings,
  BootstrapData,
  Device,
  IssueDeviceResult,
  PublicUserView,
  Server,
  TelegramSettings,
  User,
} from '@novpn/shared';
import { api } from '../api';
import type {
  AddServerInput,
  CreateUserInput,
  SaveTelegramInput,
  UpdateUserPatch,
} from '../api/types';

export type PublicRoute = 'home' | 'cabinet' | 'wizard' | 'devices' | 'apps';
export type AdminRoute =
  | 'login' | 'dashboard' | 'users' | 'user-create' | 'user-created'
  | 'user-card' | 'servers' | 'server-wizard' | 'telegram' | 'apps' | 'settings';

export interface NavParams {
  userId?: string;
  deviceId?: string;
  /** Режим мастера устройства: issue (новое) | view (просмотр). */
  wizardMode?: 'issue' | 'view';
  /** Результат последней выдачи конфига (для шага 4 мастера). */
  issued?: IssueDeviceResult & { serverId: string; appId?: string };
  /** Для админского «выпустить конфиг как пользователь». */
  asUserId?: string;
}

export interface NavState {
  area: 'public' | 'admin';
  route: PublicRoute | AdminRoute;
  params: NavParams;
}

export interface ConfirmOptions {
  title: string;
  text: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
}

interface AppContextValue {
  loading: boolean;
  loadError: string | null;
  data: BootstrapData | null;
  publicUser: PublicUserView | null;
  adminAuthed: boolean;
  nav: NavState;
  isMobile: boolean;

  reload(): Promise<void>;
  showToast(text: string): void;
  showConfirm(opts: ConfirmOptions): void;

  goPublic(route: PublicRoute, params?: NavParams): void;
  goAdmin(route: AdminRoute, params?: NavParams): void;

  // public session
  setPublicUser(u: PublicUserView | null): void;
  logoutPublic(): void;

  // device ops
  issueDevice(input: { userId: string; name: string; serverId: string; protocol: 'xray' | 'amneziawg' }): Promise<IssueDeviceResult>;
  reissueDevice(deviceId: string): Promise<IssueDeviceResult>;
  revokeDevice(deviceId: string): Promise<void>;
  deleteDevice(deviceId: string): Promise<void>;

  // admin auth
  adminLogin(login: string, password: string): Promise<boolean>;
  adminLogout(): void;

  // user ops
  createUser(input: CreateUserInput): Promise<User>;
  updateUser(id: string, patch: UpdateUserPatch): Promise<User>;
  extendUser(id: string, days: number): Promise<User>;
  setUserActive(id: string, active: boolean): Promise<User>;
  reissueCode(id: string): Promise<User>;
  setUserCode(id: string, code: string): Promise<{ ok: boolean; message?: string; user?: User }>;
  deleteUser(id: string): Promise<void>;

  // server ops
  addServer(input: AddServerInput): Promise<Server>;
  setServerDefault(id: string): Promise<void>;
  setServerAutoIssue(id: string, on: boolean): Promise<void>;
  deleteServer(id: string): Promise<void>;

  // telegram / apps / settings
  saveTelegram(input: SaveTelegramInput): Promise<TelegramSettings>;
  saveApps(apps: AppClient[]): Promise<AppClient[]>;
  saveSettings(input: AppSettings): Promise<AppSettings>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}

function detectStartArea(): 'public' | 'admin' {
  return typeof window !== 'undefined' && window.location.hash.includes('admin') ? 'admin' : 'public';
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [data, setData] = useState<BootstrapData | null>(null);
  const [publicUser, setPublicUser] = useState<PublicUserView | null>(null);
  const [adminAuthed, setAdminAuthed] = useState(false);
  const [isMobile, setIsMobile] = useState(
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 860px)').matches : false,
  );
  const startArea = detectStartArea();
  const [nav, setNav] = useState<NavState>({
    area: startArea,
    route: startArea === 'admin' ? 'login' : 'home',
    params: {},
  });

  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const [confirm, setConfirm] = useState<ConfirmOptions | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setData(await api.getInitialData());
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Не удалось загрузить данные');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 860px)');
    const onChange = () => setIsMobile(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const showToast = useCallback((text: string) => {
    setToast(text);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  const showConfirm = useCallback((opts: ConfirmOptions) => setConfirm(opts), []);

  const goPublic = useCallback((route: PublicRoute, params: NavParams = {}) => {
    setNav({ area: 'public', route, params });
    window.scrollTo(0, 0);
  }, []);
  const goAdmin = useCallback((route: AdminRoute, params: NavParams = {}) => {
    setNav({ area: 'admin', route, params });
    window.scrollTo(0, 0);
  }, []);

  // ── helpers to patch cached collections ──
  const patchData = useCallback((fn: (d: BootstrapData) => BootstrapData) => {
    setData((prev) => (prev ? fn(prev) : prev));
  }, []);
  const upsertUser = useCallback(
    (u: User) => patchData((d) => ({ ...d, users: d.users.some((x) => x.id === u.id) ? d.users.map((x) => (x.id === u.id ? u : x)) : [...d.users, u] })),
    [patchData],
  );

  const logoutPublic = useCallback(() => {
    setPublicUser(null);
    goPublic('home');
  }, [goPublic]);

  // ── device ops ──
  const issueDevice: AppContextValue['issueDevice'] = useCallback(
    async (input) => {
      const res = await api.issueDevice(input);
      patchData((d) => ({ ...d, devices: [...d.devices, res.device] }));
      return res;
    },
    [patchData],
  );
  const reissueDevice = useCallback(
    async (deviceId: string) => {
      const res = await api.reissueDevice(deviceId);
      patchData((d) => ({ ...d, devices: d.devices.map((x) => (x.id === deviceId ? res.device : x)) }));
      return res;
    },
    [patchData],
  );
  const revokeDevice = useCallback(
    async (deviceId: string) => {
      await api.revokeDevice(deviceId);
      patchData((d) => ({ ...d, devices: d.devices.map((x) => (x.id === deviceId ? { ...x, isActive: false } : x)) }));
    },
    [patchData],
  );
  const deleteDevice = useCallback(
    async (deviceId: string) => {
      await api.deleteDevice(deviceId);
      patchData((d) => ({ ...d, devices: d.devices.filter((x) => x.id !== deviceId) }));
    },
    [patchData],
  );

  // ── admin auth ──
  const adminLogin = useCallback(async (login: string, password: string) => {
    const { ok } = await api.adminLogin(login, password);
    if (ok) setAdminAuthed(true);
    return ok;
  }, []);
  const adminLogout = useCallback(() => {
    setAdminAuthed(false);
    setNav({ area: 'admin', route: 'login', params: {} });
  }, []);

  // ── user ops ──
  const createUser = useCallback(
    async (input: CreateUserInput) => {
      const u = await api.createUser(input);
      upsertUser(u);
      return u;
    },
    [upsertUser],
  );
  const updateUser = useCallback(
    async (id: string, patch: UpdateUserPatch) => {
      const u = await api.updateUser(id, patch);
      upsertUser(u);
      return u;
    },
    [upsertUser],
  );
  const extendUser = useCallback(
    async (id: string, days: number) => {
      const u = await api.extendUser(id, days);
      upsertUser(u);
      return u;
    },
    [upsertUser],
  );
  const setUserActive = useCallback(
    async (id: string, active: boolean) => {
      const u = await api.setUserActive(id, active);
      upsertUser(u);
      if (!active) patchData((d) => ({ ...d, devices: d.devices.map((x) => (x.userId === id ? { ...x, isActive: false } : x)) }));
      return u;
    },
    [upsertUser, patchData],
  );
  const reissueCode = useCallback(
    async (id: string) => {
      const u = await api.reissueCode(id);
      upsertUser(u);
      return u;
    },
    [upsertUser],
  );
  const setUserCode = useCallback(
    async (id: string, code: string) => {
      const res = await api.setUserCode(id, code);
      if ('user' in res) {
        upsertUser(res.user);
        return { ok: true, user: res.user };
      }
      return { ok: false, message: res.error.message };
    },
    [upsertUser],
  );
  const deleteUser = useCallback(
    async (id: string) => {
      await api.deleteUser(id);
      patchData((d) => ({ ...d, users: d.users.filter((u) => u.id !== id), devices: d.devices.filter((x) => x.userId !== id) }));
    },
    [patchData],
  );

  // ── server ops ──
  const addServer = useCallback(
    async (input: AddServerInput) => {
      const s = await api.addServer(input);
      patchData((d) => ({ ...d, servers: [...d.servers, s] }));
      return s;
    },
    [patchData],
  );
  const setServerDefault = useCallback(
    async (id: string) => {
      const servers = await api.setServerDefault(id);
      patchData((d) => ({ ...d, servers }));
    },
    [patchData],
  );
  const setServerAutoIssue = useCallback(
    async (id: string, on: boolean) => {
      const s = await api.setServerAutoIssue(id, on);
      patchData((d) => ({ ...d, servers: d.servers.map((x) => (x.id === id ? s : x)) }));
    },
    [patchData],
  );
  const deleteServer = useCallback(
    async (id: string) => {
      await api.deleteServer(id);
      patchData((d) => ({ ...d, servers: d.servers.filter((x) => x.id !== id), devices: d.devices.filter((x) => x.serverId !== id) }));
    },
    [patchData],
  );

  // ── telegram / apps / settings ──
  const saveTelegram = useCallback(
    async (input: SaveTelegramInput) => {
      const t = await api.saveTelegram(input);
      patchData((d) => ({ ...d, telegram: t }));
      return t;
    },
    [patchData],
  );
  const saveApps = useCallback(
    async (apps: AppClient[]) => {
      const saved = await api.saveApps(apps);
      patchData((d) => ({ ...d, apps: saved }));
      return saved;
    },
    [patchData],
  );
  const saveSettings = useCallback(
    async (input: AppSettings) => {
      const s = await api.saveSettings(input);
      patchData((d) => ({ ...d, settings: s }));
      return s;
    },
    [patchData],
  );

  const value = useMemo<AppContextValue>(
    () => ({
      loading, loadError, data, publicUser, adminAuthed, nav, isMobile,
      reload, showToast, showConfirm, goPublic, goAdmin,
      setPublicUser, logoutPublic,
      issueDevice, reissueDevice, revokeDevice, deleteDevice,
      adminLogin, adminLogout,
      createUser, updateUser, extendUser, setUserActive, reissueCode, setUserCode, deleteUser,
      addServer, setServerDefault, setServerAutoIssue, deleteServer,
      saveTelegram, saveApps, saveSettings,
    }),
    [
      loading, loadError, data, publicUser, adminAuthed, nav, isMobile,
      reload, showToast, showConfirm, goPublic, goAdmin, setPublicUser, logoutPublic,
      issueDevice, reissueDevice, revokeDevice, deleteDevice, adminLogin, adminLogout,
      createUser, updateUser, extendUser, setUserActive, reissueCode, setUserCode, deleteUser,
      addServer, setServerDefault, setServerAutoIssue, deleteServer, saveTelegram, saveApps, saveSettings,
    ],
  );

  return (
    <AppContext.Provider value={value}>
      {children}
      <ToastHost toast={toast} />
      <ConfirmHost confirm={confirm} onClose={() => setConfirm(null)} />
    </AppContext.Provider>
  );
}

// ── Toast & Confirm overlays (глобальные) ──
function ToastHost({ toast }: { toast: string | null }) {
  if (!toast) return null;
  return (
    <div
      style={{
        position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
        background: 'var(--surface-toast)', color: 'var(--text-primary)', fontSize: 14, fontWeight: 600,
        padding: '12px 20px', borderRadius: 12, zIndex: 200, boxShadow: 'var(--shadow-toast)', maxWidth: '90vw',
      }}
      role="status"
    >
      {toast}
    </div>
  );
}

function ConfirmHost({ confirm, onClose }: { confirm: ConfirmOptions | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  if (!confirm) return null;
  const run = async () => {
    setBusy(true);
    try {
      await confirm.onConfirm();
    } finally {
      setBusy(false);
      onClose();
    }
  };
  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 150, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--surface-dialog)', borderRadius: 'var(--r-dialog)', padding: 24, width: 'min(360px, 100%)', display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <div style={{ fontSize: 17, fontWeight: 700 }}>{confirm.title}</div>
        <div style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--text-body)' }}>{confirm.text}</div>
        <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
          <button className="btn btn-secondary" style={{ flex: 1, height: 46, borderRadius: 12 }} onClick={onClose} disabled={busy}>
            Отмена
          </button>
          <button
            className={`btn ${confirm.danger ? 'btn-danger' : 'btn-primary'}`}
            style={{ flex: 1, height: 46, borderRadius: 12 }}
            onClick={run}
            disabled={busy}
          >
            {confirm.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export type { Device, Server, User };
