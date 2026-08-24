// Центральный store: данные, навигация, вход администратора, toast, confirm.
// Экраны зависят только от useApp(). Все мутации идут через api-адаптер.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppClient,
  AppSettings,
  BootstrapData,
  Device,
  IssueDeviceResult,
  PublicBootstrapData,
  PublicUserView,
  Server,
  TelegramSettings,
  User,
} from '@novpn/shared';
import { api } from '../api';
import type {
  AddServerInput,
  CreateUserInput,
  EditServerInput,
  SaveTelegramInput,
  UpdateUserPatch,
} from '../api/types';

export type PublicRoute = 'home' | 'cabinet' | 'wizard' | 'devices' | 'apps';
export type AdminRoute =
  | 'login' | 'dashboard' | 'users' | 'user-create' | 'user-created'
  | 'user-card' | 'servers' | 'server-wizard' | 'telegram' | 'apps' | 'logs' | 'settings'
  | 'smart-routing' | 'desktop-updates';

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
  /** Полные данные панели. Есть только у вошедшего админа. */
  data: BootstrapData | null;
  /** Данные публичной части: справочники + СВОИ устройства (после входа по коду). */
  publicData: PublicBootstrapData | null;
  publicUser: PublicUserView | null;
  /** Сообщение, если вход по личной ссылке не удался. */
  linkNotice: string | null;
  adminAuthed: boolean;
  /** Пароль админа ещё дефолтный — панель просит сменить. */
  mustChangePassword: boolean;
  nav: NavState;
  isMobile: boolean;

  reload(): Promise<void>;
  reloadPublic(): Promise<void>;
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
  renameDevice(deviceId: string, name: string): Promise<void>;
  cleanupDevices(ids: string[]): Promise<number>;

  // admin auth
  adminLogin(password: string): Promise<boolean>;
  adminLogout(): void;

  // user ops
  createUser(input: CreateUserInput): Promise<User>;
  updateUser(id: string, patch: UpdateUserPatch): Promise<User>;
  extendUser(id: string, days: number): Promise<User>;
  setUserActive(id: string, active: boolean): Promise<User>;
  reissueCode(id: string): Promise<User>;
  /** Задать пользователю свой код (6 цифр, уникальность — на сервере). */
  setCode(id: string, code: string): Promise<User>;
  /** Выдать новую личную ссылку — старая сразу перестаёт работать. */
  reissueLink(id: string): Promise<User>;
  /** Включить/выключить запасной вход по коду. */
  setCodeLogin(id: string, enabled: boolean): Promise<User>;
  deleteUser(id: string): Promise<void>;

  // server ops
  addServer(input: AddServerInput): Promise<Server>;
  editServer(id: string, input: EditServerInput): Promise<Server>;
  setServerAutoIssue(id: string, on: boolean): Promise<void>;
  deleteServer(id: string, purgeEndpoint?: boolean): Promise<void>;

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

// ── path-роутинг ──
// Каждый экран — свой URL: /admin/users/<id>, /admin/settings, /cabinet, /connect…
// Работают F5 (deep-link), кнопка «назад» (popstate) и ссылки на конкретные экраны.
// Сложные параметры (issued, wizardMode) в URL не сериализуем: после F5 экран
// откроется в своём начальном состоянии — это осознанно.

/** URL для состояния навигации. login не имеет своего URL (это оверлей поверх /admin/*). */
function pathForNav(nav: NavState): string {
  if (nav.area === 'admin') {
    switch (nav.route) {
      case 'users': return '/admin/users';
      case 'user-create': return '/admin/users/new';
      case 'user-created': return '/admin/users/created';
      case 'user-card': return nav.params.userId ? `/admin/users/${nav.params.userId}` : '/admin/users';
      case 'servers': return '/admin/servers';
      case 'server-wizard': return '/admin/servers/new';
      case 'telegram': return '/admin/telegram';
      case 'apps': return '/admin/apps';
      case 'logs': return '/admin/logs';
      case 'settings': return '/admin/settings';
      case 'smart-routing': return '/admin/smart-routing';
      case 'desktop-updates': return '/admin/desktop';
      default: return '/admin'; // dashboard и login
    }
  }
  switch (nav.route) {
    case 'cabinet': return '/cabinet';
    case 'wizard': return '/connect';
    case 'devices': return '/devices';
    case 'apps': return '/apps';
    default: return '/';
  }
}

/** Обратное преобразование: URL → состояние навигации (для старта и кнопки «назад»). */
function navForPath(p: string): NavState {
  if (p === '/admin' || p.startsWith('/admin/')) {
    const seg = p.slice('/admin'.length).split('/').filter(Boolean);
    if (seg[0] === 'users') {
      if (!seg[1]) return { area: 'admin', route: 'users', params: {} };
      if (seg[1] === 'new') return { area: 'admin', route: 'user-create', params: {} };
      if (seg[1] === 'created') return { area: 'admin', route: 'user-created', params: {} };
      return { area: 'admin', route: 'user-card', params: { userId: seg[1] } };
    }
    if (seg[0] === 'servers') {
      return seg[1] === 'new'
        ? { area: 'admin', route: 'server-wizard', params: {} }
        : { area: 'admin', route: 'servers', params: {} };
    }
    if (seg[0] === 'telegram' || seg[0] === 'apps' || seg[0] === 'logs' || seg[0] === 'settings' || seg[0] === 'smart-routing') {
      return { area: 'admin', route: seg[0], params: {} };
    }
    if (seg[0] === 'desktop') return { area: 'admin', route: 'desktop-updates', params: {} };
    return { area: 'admin', route: 'dashboard', params: {} };
  }
  if (p === '/cabinet') return { area: 'public', route: 'cabinet', params: {} };
  if (p === '/connect') return { area: 'public', route: 'wizard', params: {} };
  if (p === '/devices') return { area: 'public', route: 'devices', params: {} };
  if (p === '/apps') return { area: 'public', route: 'apps', params: {} };
  return { area: 'public', route: 'home', params: {} };
}

function initialNav(): NavState {
  if (typeof window === 'undefined') return { area: 'public', route: 'home', params: {} };
  // Легаси-якорь #admin поддерживаем для старых закладок.
  if (window.location.hash.includes('admin') && !window.location.pathname.startsWith('/admin')) {
    return { area: 'admin', route: 'dashboard', params: {} };
  }
  return navForPath(window.location.pathname);
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [data, setData] = useState<BootstrapData | null>(null);
  const [publicData, setPublicData] = useState<PublicBootstrapData | null>(null);
  const [publicUser, setPublicUser] = useState<PublicUserView | null>(null);
  /** Ссылка не сработала (протухла/отозвана) — показываем это на входе. */
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const [adminAuthed, setAdminAuthed] = useState(false);
  // Пароль администратора всё ещё стандартный («admin») — показываем предупреждение.
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [isMobile, setIsMobile] = useState(
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 860px)').matches : false,
  );
  // Стартовое состояние — из URL (deep-link): /admin/settings откроет настройки
  // (после входа, если сессии нет — AdminShell покажет экран входа, маршрут сохранится).
  const [nav, setNav] = useState<NavState>(initialNav);

  // Протухла админ-сессия (401 от админ-API) → мягко разлогиниваем: показываем экран
  // входа вместо «дохлой» ошибки посреди действия.
  useEffect(() => {
    const onExpired = () => setAdminAuthed(false);
    window.addEventListener('novpn:auth-expired', onExpired);
    return () => window.removeEventListener('novpn:auth-expired', onExpired);
  }, []);

  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const [confirm, setConfirm] = useState<ConfirmOptions | null>(null);

  // Полные данные панели — только для админа (сервер вернёт 401 остальным).
  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const d = await api.getInitialData();
      setData(d);
      // Флаг обязательной смены переживает перезагрузку страницы (не только вход).
      setMustChangePassword(!!d.mustChangePassword);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Не удалось загрузить данные');
    } finally {
      setLoading(false);
    }
  }, []);

  // Публичные данные: справочники всем, устройства — только свои, по сессии.
  const reloadPublic = useCallback(async () => {
    const pd = await api.getPublicData();
    setPublicData(pd);
    // Сессия живёт в куке, поэтому после F5 пользователь остаётся вошедшим.
    setPublicUser(pd.user);
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        // Вход по личной ссылке /k/<токен>: логинимся ДО загрузки данных,
        // чтобы сразу получить свои устройства. Токен из адреса убираем —
        // незачем оставлять его в истории браузера и в заголовке вкладки.
        const m = /^\/k\/([A-Za-z0-9_-]+)/.exec(window.location.pathname);
        let linkError: string | null = null;
        if (m) {
          try {
            const res = await api.tokenLogin(m[1]!);
            if ('error' in res) linkError = res.error.message;
          } catch (e) {
            linkError = e instanceof Error ? e.message : 'Не удалось войти по ссылке.';
          }
          window.history.replaceState(null, '', '/');
        }

        // Стартуем всегда с публичных данных: они безопасны и нужны всем.
        // Если в куке есть админская сессия — дотягиваем полные.
        const pd = await api.getPublicData();
        if (!alive) return;
        setPublicData(pd);
        setPublicUser(pd.user);
        if (m && pd.user) {
          setNav({ area: 'public', route: 'cabinet', params: {} });
          window.history.replaceState(null, '', '/cabinet'); // URL экрана, токена в истории нет
        }
        if (linkError) setLinkNotice(linkError);
        try {
          const full = await api.getInitialData();
          if (!alive) return;
          setData(full);
          setAdminAuthed(true);
          // Флаг обязательной смены пароля должен переживать F5 (не только вход) —
          // иначе после перезагрузки страницы экран смены пропадал, а мутации 403-или.
          setMustChangePassword(!!full.mustChangePassword);
        } catch {
          /* не админ — это норма, публичная часть уже загружена */
        }
      } catch (e) {
        if (alive) setLoadError(e instanceof Error ? e.message : 'Не удалось загрузить данные');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 860px)');
    const onChange = () => setIsMobile(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Один раз на маунт нормализуем адрес: легаси-якорь #admin и /k/<токен> уже
  // разобраны в initialNav/tokenLogin — приводим строку к каноническому пути экрана.
  useEffect(() => {
    const path = pathForNav(nav);
    if (window.location.pathname !== path || window.location.hash) window.history.replaceState(null, '', path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showToast = useCallback((text: string) => {
    setToast(text);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  const showConfirm = useCallback((opts: ConfirmOptions) => setConfirm(opts), []);

  // Навигация двигает и URL (pushState) — работают «назад», F5 и ссылки на экраны.
  const pushNav = useCallback((next: NavState) => {
    setNav(next);
    const path = pathForNav(next);
    if (window.location.pathname !== path) window.history.pushState(null, '', path);
    window.scrollTo(0, 0);
  }, []);
  const goPublic = useCallback((route: PublicRoute, params: NavParams = {}) => {
    pushNav({ area: 'public', route, params });
  }, [pushNav]);
  const goAdmin = useCallback((route: AdminRoute, params: NavParams = {}) => {
    pushNav({ area: 'admin', route, params });
  }, [pushNav]);

  // Кнопка «назад/вперёд» браузера: восстанавливаем экран из URL без нового push.
  useEffect(() => {
    const onPop = () => setNav(navForPath(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
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
    // Гасим и серверную сессию, иначе устройства остались бы доступны по куке.
    void api.publicLogout().catch(() => {});
    setPublicData((prev: PublicBootstrapData | null) => (prev ? { ...prev, user: null, devices: [] } : prev));
    goPublic('home');
  }, [goPublic]);

  // ── device ops ──
  // Устройства живут в двух кэшах: полном (панель админа) и публичном (кабинет).
  // Патчим оба — какой из них заполнен, зависит от того, кто вошёл.
  const patchDevices = useCallback((fn: (list: Device[]) => Device[]) => {
    setData((prev) => (prev ? { ...prev, devices: fn(prev.devices) } : prev));
    setPublicData((prev) => (prev ? { ...prev, devices: fn(prev.devices) } : prev));
  }, []);

  // Устройство из результата выпуска НЕ содержит вычисляемый vpnKey (его считает
  // listDevicesOfUser из conf). Переносим conf/vpnKey из результата в кэш, иначе
  // после выпуска/перевыпуска кнопка «Открыть в AmneziaVPN» пропадала до перезагрузки.
  const devFromResult = (res: IssueDeviceResult): Device => ({
    ...res.device,
    conf: res.conf ?? res.device.conf,
    vpnKey: res.vpnKey ?? res.device.vpnKey,
  });
  const issueDevice: AppContextValue['issueDevice'] = useCallback(
    async (input) => {
      const res = await api.issueDevice(input);
      const dev = devFromResult(res);
      // Upsert по id: при переиспользовании Xray-конфига сервер возвращает уже
      // существующее устройство (тот же id) — push дал бы дубль в списке.
      patchDevices((list) => {
        const i = list.findIndex((d) => d.id === dev.id);
        if (i === -1) return [...list, dev];
        const next = [...list];
        next[i] = dev;
        return next;
      });
      return res;
    },
    [patchDevices],
  );
  const reissueDevice = useCallback(
    async (deviceId: string) => {
      const res = await api.reissueDevice(deviceId);
      patchDevices((list) => list.map((x) => (x.id === deviceId ? devFromResult(res) : x)));
      return res;
    },
    [patchDevices],
  );
  const revokeDevice = useCallback(
    async (deviceId: string) => {
      await api.revokeDevice(deviceId);
      patchDevices((list) => list.map((x) => (x.id === deviceId ? { ...x, isActive: false } : x)));
    },
    [patchDevices],
  );
  const deleteDevice = useCallback(
    async (deviceId: string) => {
      const r = await api.deleteDevice(deviceId);
      // Сервер мог НЕ удалить (был недоступен) и оставить запись как pending — тогда не
      // выкидываем её из кэша, а помечаем неактивной (иначе «исчезла», а на перезагрузке — вернулась).
      if (r.pending) {
        patchDevices((list) => list.map((x) => (x.id === deviceId ? { ...x, isActive: false } : x)));
        if (r.message) showToast(r.message);
      } else {
        patchDevices((list) => list.filter((x) => x.id !== deviceId));
      }
    },
    [patchDevices, showToast],
  );
  const renameDevice = useCallback(
    async (deviceId: string, name: string) => {
      const d = await api.renameDevice(deviceId, name);
      patchDevices((list) => list.map((x) => (x.id === deviceId ? { ...x, name: d.name } : x)));
    },
    [patchDevices],
  );
  const cleanupDevices = useCallback(
    async (ids: string[]) => {
      const { deleted, keptIds = [] } = await api.cleanupDevices(ids);
      // Удаляем из кэша только реально удалённые; оставленные сервером (был недоступен)
      // помечаем неактивными, а не выкидываем — иначе рассинхрон кэша с БД.
      patchDevices((list) =>
        list
          .filter((x) => !ids.includes(x.id) || keptIds.includes(x.id))
          .map((x) => (keptIds.includes(x.id) ? { ...x, isActive: false } : x)),
      );
      return deleted;
    },
    [patchDevices],
  );

  // ── admin auth ──
  const adminLogin = useCallback(async (password: string) => {
    const { ok, mustChangePassword } = await api.adminLogin(password);
    if (ok) {
      setAdminAuthed(true);
      setMustChangePassword(!!mustChangePassword);
      // Полные данные панели доступны только теперь — до входа сервер их не отдавал.
      await reload();
    }
    return ok;
  }, [reload]);
  const adminLogout = useCallback(() => {
    setAdminAuthed(false);
    setData(null);
    void api.adminLogout().catch(() => {});
    setNav({ area: 'admin', route: 'login', params: {} });
    if (window.location.pathname !== '/admin') window.history.pushState(null, '', '/admin');
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
  const setCode = useCallback(
    async (id: string, code: string) => {
      const u = await api.setCode(id, code);
      upsertUser(u);
      return u;
    },
    [upsertUser],
  );
  const reissueLink = useCallback(
    async (id: string) => {
      const u = await api.reissueLink(id);
      upsertUser(u);
      return u;
    },
    [upsertUser],
  );
  const setCodeLogin = useCallback(
    async (id: string, enabled: boolean) => {
      const u = await api.setCodeLogin(id, enabled);
      upsertUser(u);
      return u;
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
  const editServer = useCallback(
    async (id: string, input: EditServerInput) => {
      const s = await api.editServer(id, input);
      patchData((d) => ({ ...d, servers: d.servers.map((x) => (x.id === id ? s : x)) }));
      return s;
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
    async (id: string, purgeEndpoint?: boolean) => {
      await api.deleteServer(id, purgeEndpoint);
      if (purgeEndpoint) {
        patchData((d) => ({ ...d, servers: d.servers.filter((x) => x.id !== id), devices: d.devices.filter((x) => x.serverId !== id) }));
      } else {
        // detach: сервер остаётся (endpoint жив), помечаем detached — перезагрузим данные.
        void reload();
      }
    },
    [patchData, reload],
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
      loading, loadError, data, publicData, publicUser, linkNotice, adminAuthed, mustChangePassword, nav, isMobile,
      reload, reloadPublic, showToast, showConfirm, goPublic, goAdmin,
      setPublicUser, logoutPublic,
      issueDevice, reissueDevice, revokeDevice, deleteDevice, renameDevice, cleanupDevices,
      adminLogin, adminLogout,
      createUser, updateUser, extendUser, setUserActive, reissueCode, setCode, reissueLink, setCodeLogin, deleteUser,
      addServer, editServer, setServerAutoIssue, deleteServer,
      saveTelegram, saveApps, saveSettings,
    }),
    [
      loading, loadError, data, publicData, publicUser, linkNotice, adminAuthed, mustChangePassword, nav, isMobile,
      reload, reloadPublic, showToast, showConfirm, goPublic, goAdmin, setPublicUser, logoutPublic,
      issueDevice, reissueDevice, revokeDevice, deleteDevice, renameDevice, cleanupDevices, adminLogin, adminLogout,
      createUser, updateUser, extendUser, setUserActive, reissueCode, setCode, reissueLink, setCodeLogin, deleteUser,
      addServer, editServer, setServerAutoIssue, deleteServer, saveTelegram, saveApps, saveSettings,
    ],
  );

  return (
    <AppContext.Provider value={value}>
      {children}
      <ToastHost toast={toast} />
      <ConfirmHost confirm={confirm} onClose={() => setConfirm(null)} onError={showToast} />
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

function ConfirmHost({
  confirm,
  onClose,
  onError,
}: {
  confirm: ConfirmOptions | null;
  onClose: () => void;
  onError: (text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!confirm) return null;
  const run = async () => {
    setBusy(true);
    try {
      await confirm.onConfirm();
    } catch (e) {
      // Без catch любая ошибка API молча терялась, а окно закрывалось так же,
      // как при успехе: человек был уверен, что устройство отключено или конфиг
      // перевыпущен, хотя ничего не произошло. Действие не выполнено — скажем это.
      onError(e instanceof Error ? e.message : 'Не удалось выполнить действие');
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
