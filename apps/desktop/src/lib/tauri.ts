/* Мостик к оболочке. В браузере всё это молча возвращает заглушки — прототип
   должен открываться и без Tauri, иначе быстрый цикл правок сломается. */

export const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!inTauri) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  return (await invoke(cmd, args)) as T;
}

/** Как `call`, но ошибку не глотает: её нужно показать человеку. */
async function callOrThrow<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return (await invoke(cmd, args)) as T;
}

/* ── Окно и трей ──────────────────────────────────────────── */

export const syncTray = (connected: boolean) => call('set_tray_state', { connected }).catch(() => null);
export const syncCloseToTray = (enabled: boolean) => call('set_close_to_tray', { enabled }).catch(() => null);
export const quitApp = () => call('quit_app').catch(() => null);

export async function hideWindow(): Promise<void> {
  if (!inTauri) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().hide();
}

export async function minimizeWindow(): Promise<void> {
  if (!inTauri) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().minimize();
}

export async function onTrayToggle(cb: () => void): Promise<() => void> {
  if (!inTauri) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return await listen('tray-toggle', () => cb());
}

/** Отложенная подписка из глубокой ссылки novpn:// (холодный старт). */
export const takeDeepLink = () => call('take_deep_link') as Promise<string | null>;

/** Глубокая ссылка, пришедшая на уже запущенное приложение (тёплый старт). */
export async function onDeepLink(cb: (url: string) => void): Promise<() => void> {
  if (!inTauri) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return await listen<string>('deep-link', (e) => cb(e.payload));
}

/* ── Подписка и подключение ───────────────────────────────── */

export interface ServerInfo {
  name: string;
  server: string;
  port: number;
  kind: string;
  /** Профиль панели NoVPN (meta.novpn конфига). У чужих подписок — null. */
  profileId: string | null;
  serverId: string | null;
  /** `smart` | `full`. Без meta.novpn — всегда smart. */
  mode: 'smart' | 'full';
}

export interface SubResult {
  servers: ServerInfo[];
  format: string;
}

export interface RulesPayload {
  /** false = профиль «Полный VPN»: всё в туннель, без исключений, fail-close. */
  smart: boolean;
  /** Серверная политика LAN из meta.json: false — напрямую, true — в туннель. */
  lanAccess: boolean;
  /** Режим сетевого адаптера вместо системного прокси. */
  tunnel: boolean;
  /** Обход локальных доменов напрямую. */
  bypassLocal: boolean;
  customLocal: string[];
  dnsProvider: string;
  /** Домены, заданные человеком, уже в порядке важности: браузер, затем окно.
      Их не отменяет ни один подгруженный список. */
  userDomains: { domain: string; route: 'vpn' | 'direct' }[];
  listDirectDomains: string[];
  listVpnDomains: string[];
  listVpnFull: string[];
  listVpnKeywords: string[];
  listVpnRegex: string[];
  listVpnIps: string[];
  vpnProcesses: string[];
  directProcesses: string[];
}

/* ── Метаданные подписки (контракт панель↔клиент) ─────────── */

export interface MetaRouting {
  mode: 'smart' | 'full' | string;
  lanAccess: boolean;
  fallbackTypes: string[] | null;
  ownExceptions: number;
  /** Через сколько часов полный VPN сам вернётся на умный. 0 — не возвращать. */
  fullTimeoutHours: number;
  expiresAt?: string | null;
  fallbackProfileId?: string | null;
}
export interface MetaProfile {
  profileId: string;
  serverId: string;
  host: string;
  remark: string;
  recommended: boolean;
  protocols: string[];
  online: boolean;
  subLink: string;
  routing: MetaRouting;
}
export interface Meta {
  schemaVersion: number;
  panel: { name?: string; origin?: string } | null;
  routingResources: Record<string, string>;
  profiles: MetaProfile[];
}
/** Отказ панели (4xx) — авторитетный: подключаться нельзя, причину показываем. */
export interface MetaDenied {
  status: number;
  kind: 'not_found' | 'disabled' | 'expired' | 'traffic' | string;
  message: string;
}
export interface MetaResult {
  meta: Meta | null;
  /** network — свежий ответ; cache — панель не ответила, last-known-good; none — нет meta. */
  source: 'network' | 'cache' | 'none';
  denied: MetaDenied | null;
  unsupported: boolean;
  networkError: string | null;
}

/** Профили и их режимы с панели. Никогда не бросает. */
export const metaFetch = (url?: string) =>
  call<MetaResult>('meta_fetch', { url: url ?? null }).then(
    (v) => v ?? { meta: null, source: 'none' as const, denied: null, unsupported: false, networkError: null },
  );

export const subFetch = (url: string) => callOrThrow<SubResult>('sub_fetch', { url });
export const subCached = () => callOrThrow<SubResult>('sub_cached');

export const vpnConnect = (selected: string | null, rules: RulesPayload) =>
  callOrThrow<void>('vpn_connect', { selected, rules });

export const vpnDisconnect = () => callOrThrow<void>('vpn_disconnect');

/** Применяет изменённые правила к работающему движку, не разрывая соединений. */
export const vpnReload = (selected: string | null, rules: RulesPayload) =>
  callOrThrow<void>('vpn_reload', { selected, rules });
export const vpnAlive = () => call<boolean>('vpn_alive').then((v) => v ?? false);
export const vpnPort = () => call<number>('vpn_port');

/** Открыть папку настроек NoVPN в проводнике. */
export const openConfigDir = () => call('open_config_dir').catch(() => null);
/** Открыть журнал движка. */
export const openEngineLog = () => call('open_engine_log').catch(() => null);
/** Открыть URL в браузере по умолчанию. */
export const openUrl = (url: string) => call('open_url', { url }).catch(() => null);

/** Настоящее состояние автозапуска, а не сохранённое в файле. */
export const autostartGet = () => call<boolean>('autostart_get').then((v) => v ?? false);
/** Приводит автозапуск к нужному виду с учётом режима адаптера. */
export const autostartSync = (autostart: boolean, tunnel: boolean) =>
  call('autostart_sync', { autostart, tunnel }).catch(() => null);
/** Настроен ли тихий elevated-автозапуск (задача планировщика). */
export const autostartHasTask = () => call<boolean>('autostart_has_task').then((v) => v ?? false);

export interface AppItem {
  name: string;
  processes: string[];
  path: string | null;
  running: boolean;
}

/** Установленные программы (из реестра). */
export const appsInstalled = () => call<AppItem[]>('apps_installed').then((v) => v ?? []);
/** Запущенные сейчас процессы, свёрнутые по имени файла. */
export const appsRunning = () => call<AppItem[]>('apps_running').then((v) => v ?? []);

/** Системное окно выбора: .exe или папка. Возвращает путь или null. */
export async function pickExe(): Promise<string | null> {
  if (!inTauri) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const r = await open({ filters: [{ name: 'Программа', extensions: ['exe'] }], multiple: false, directory: false });
  return typeof r === 'string' ? r : null;
}
export async function pickFolder(): Promise<string | null> {
  if (!inTauri) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const r = await open({ directory: true, multiple: false });
  return typeof r === 'string' ? r : null;
}

export interface UpdateInfo {
  available: boolean;
  current: string;
  latest: string;
  notes: string;
  sizeBytes: number;
}

/** Проверка обновления на GitHub. */
export const updateCheck = () => callOrThrow<UpdateInfo>('update_check');
/** Скачать и запустить установщик новой версии. */
export const updateInstall = () => callOrThrow<void>('update_install');

/** Запущено ли приложение с правами администратора. */
export const isElevated = () => call<boolean>('is_elevated').then((v) => v ?? false);
/** Перезапуск с запросом прав. Согласие даёт человек в окне Windows. */
export const relaunchElevated = () => callOrThrow<void>('relaunch_elevated');

/* ── Хранение ─────────────────────────────────────────────── */

export interface ServerLists {
  /** Домены с поддоменами → через VPN. */
  vpnDomains: string[];
  /** Остальные виды из грамматики upstream: точные домены, подстроки, регэкспы, подсети. */
  vpnFull: string[];
  vpnKeywords: string[];
  vpnRegex: string[];
  vpnIps: string[];
  directDomains: string[];
  apps: { id: string; name: string; route: 'vpn' | 'direct'; processes: string[] }[];
  /** Сколько элементов пришло в каждом файле. */
  counts: [string, number][];
  /** Версия базы по манифесту панели («Правила vN»). */
  version: number | null;
  updatedAt: string | null;
}

/** Обновляет списки с сервера NoVPN. */
export const listsSync = () => callOrThrow<ServerLists>('lists_sync');
/** Списки, уже лежащие на диске. */
export const listsLoad = () => call<ServerLists>('lists_load');

export interface BrowserRule {
  domain: string;
  route: 'vpn' | 'direct';
}

export interface InstalledBrowser {
  id: string;
  name: string;
  path: string;
}

export interface DomainVerdict {
  route: 'vpn' | 'direct' | string;
  reason: string;
  matched: string;
}

/** Почему домен идёт туда, куда идёт. Прогоняется по тем же правилам, что и движок. */
export const explainDomain = (domain: string, rules: RulesPayload) =>
  call<DomainVerdict>('explain_domain', { domain, rules });

/** Браузеры, которые РЕАЛЬНО стоят на компьютере (реестр StartMenuInternet).
 *  Раньше список был выдуман: Яндекс значился найденным на любой машине. */
export const browsersInstalled = () => call<InstalledBrowser[]>('browsers_installed');

/** Чужие VPN-туннели, поднятые прямо сейчас (пустой список — конфликтов нет).
 *  Два туннеля одновременно забирают маршрут по умолчанию каждый на себя, и интернет
 *  пропадает совсем — человеку это надо сказать, а не оставлять гадать. */
export const vpnConflicts = () => call<string[]>('vpn_conflicts');

/** Правила, добавленные кнопкой в браузере. */
export const browserRules = () => call<BrowserRule[]>('browser_rules');

export const stateLoad = <T>(name: string) => call<T | null>('state_load', { name });
export const stateSave = (name: string, value: unknown) =>
  call('state_save', { name, value }).catch(() => null);
