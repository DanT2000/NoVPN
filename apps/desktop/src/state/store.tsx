/* Состояние приложения.

   В окне Tauri работает по-настоящему: подписка скачивается, движок
   запускается, настройки и правила ложатся на диск и переживают перезапуск.
   В браузере те же действия отыгрываются заглушками — иначе быстрый цикл
   правок интерфейса был бы невозможен. */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { DIRECT_DOMAINS, INITIAL, SUGGESTED } from '../mock/data';
import {
  appsInstalled,
  appsRunning,
  autostartSync,
  browserRules,
  inTauri,
  listsLoad,
  listsSync,
  metaFetch,
  stateLoad,
  stateSave,
  subCached,
  subFetch,
  vpnAlive,
  vpnConnect,
  vpnDisconnect,
  vpnReload,
  explainDomain,
  updateCheck,
  updateInstall,
} from '../lib/tauri';
import type { MetaResult, ServerLists } from '../lib/tauri';
import type {
  ConnState,
  MetaState,
  Mode,
  Route,
  RoutingTab,
  Server,
  Settings,
  SiteRule,
  State,
  Tab,
} from './types';

/* ── Профили по контракту панели ─────────────────────────────
   Сервер в подписке NoVPN приходит одним или двумя профилями: умный и «Полный
   VPN», с общим serverId. В интерфейсе показываем ОДИН сервер, а тумблер «Умная
   маршрутизация» выбирает, каким профилем подключаться. Выключить умную можно
   только если сервер выдал полный профиль (контракт, раздел 1). Чужие подписки
   (без meta.novpn) — один профиль, всегда smart. */

/** Ключ группировки: серверы панели — по serverId, чужие — по имени. */
export function serverKey(v: Server): string {
  return v.serverId ?? v.id;
}

/** Все профили выбранного сервера. */
function groupOf(s: State): Server[] {
  const cur = s.servers.find((v) => v.id === s.serverId);
  if (!cur) return [];
  const key = serverKey(cur);
  return s.servers.filter((v) => serverKey(v) === key);
}

/** Есть ли у выбранного сервера профиль «Полный VPN». */
export function fullAvailableFor(s: State): boolean {
  return groupOf(s).some((v) => v.mode === 'full');
}

/** Реальный режим подключения: выключенная умная действует только при наличии
    полного профиля — иначе тихо остаёмся в smart, чтобы не подменять поведение. */
export function effectiveSmart(s: State): boolean {
  return s.smartRouting || !fullAvailableFor(s);
}

/** Профиль, которым подключаемся: полный при выключенной умной, иначе умный. */
export function nodeFor(s: State): Server | null {
  const group = groupOf(s);
  if (group.length === 0) return null;
  const smart = !effectiveSmart(s) ? group.find((v) => v.mode === 'full') : undefined;
  return smart ?? group.find((v) => v.mode !== 'full') ?? group[0]!;
}

/** Серверная политика LAN для выбранного профиля (meta.routing.lanAccess). */
function lanAccessFor(s: State, node: Server | null): boolean {
  if (!node?.profileId || !s.meta) return false;
  return s.meta.profiles.find((p) => p.profileId === node.profileId)?.lanAccess ?? false;
}

/** Представитель группы для списка серверов: умный профиль (он рекомендуемый). */
export function representatives(servers: Server[]): Server[] {
  const seen = new Map<string, Server>();
  for (const v of servers) {
    const k = serverKey(v);
    const prev = seen.get(k);
    if (!prev || (prev.mode === 'full' && v.mode !== 'full')) seen.set(k, v);
  }
  return [...seen.values()];
}

function toMetaState(r: MetaResult): MetaState {
  return {
    source: r.source,
    profiles: (r.meta?.profiles ?? []).map((p) => ({
      profileId: p.profileId,
      serverId: p.serverId,
      host: p.host,
      remark: p.remark,
      recommended: !!p.recommended,
      mode: p.routing?.mode === 'full' ? 'full' : 'smart',
      lanAccess: !!p.routing?.lanAccess,
      fullTimeoutHours: Math.max(0, Number(p.routing?.fullTimeoutHours ?? 0) || 0),
    })),
    denied: r.denied ? { kind: r.denied.kind, message: r.denied.message } : null,
    unsupported: !!r.unsupported,
  };
}

interface OnboardingPrefs {
  autostart?: boolean;
  smart?: boolean;
  autoUpdateLists?: boolean;
  bypassLocal?: boolean;
  /** id рекомендованных приложений, отмеченных галочкой. */
  appIds?: string[];
  /** Использовать готовый список недоступных ресурсов. */
  useList?: boolean;
}

interface Nav {
  tab: Tab;
  routingTab: RoutingTab;
  /** Шаг первого запуска: 0 — подписка, 1 — быстрая настройка. */
  onboardingStep: 0 | 1;
  /** Быстрая настройка, запущенная повторно из настроек: показываем тот же
      экран галочек поверх уже настроенного приложения, ничего не стирая. */
  quickSetup: boolean;
}

/* Открыть нужный экран сразу, минуя клики: ?onboarded=1&tab=routing&rt=sites
   Только в режиме разработки — для разбора вёрстки и снятия видов. */
function fromUrl(): { s: State; nav: Nav } {
  const s: State = { ...INITIAL };
  const nav: Nav = { tab: 'home', routingTab: 'apps', onboardingStep: 0, quickSetup: false };
  if (!import.meta.env.DEV || typeof location === 'undefined') return { s, nav };
  const q = new URLSearchParams(location.search);
  if (q.get('onboarded') === '1') {
    s.onboarded = true;
    s.subscription = { url: 'https://vpn.appswire.ru/sub/demo', status: 'active', servers: 2 };
    s.servers = [
      { id: 'Finland 1', name: 'Finland 1', host: '1.vpn.appswire.ru', port: 443, kind: 'vless', ping: 42 },
      { id: 'HomeVPN', name: 'HomeVPN', host: 'homevpn.appswire.ru', port: 30121, kind: 'vless', ping: 121 },
    ];
    s.serverId = 'Finland 1';
  }
  const conn = q.get('conn');
  if (conn) s.conn = conn as ConnState;
  const mode = q.get('mode');
  if (mode) s.mode = mode as Mode;
  // Режим адаптера и умная маршрутизация — тоже для снятия видов.
  if (q.get('tunnel') === '1') s.settings.tunnel = true;
  if (q.get('smart') === '0') s.smartRouting = false;
  const tab = q.get('tab');
  if (tab) nav.tab = tab as Tab;
  const rt = q.get('rt');
  if (rt) nav.routingTab = rt as RoutingTab;
  const step = q.get('step');
  if (step) nav.onboardingStep = Number(step) as 0 | 1;
  if (q.get('quick') === '1') nav.quickSetup = true;
  const theme = q.get('theme');
  if (theme === 'light' || theme === 'dark' || theme === 'system') s.settings.theme = theme;
  return { s, nav };
}

interface Ctx {
  s: State;
  nav: Nav;
  go: (tab: Tab) => void;
  goRouting: (t: RoutingTab) => void;
  setOnboardingStep: (n: 0 | 1) => void;

  connect: () => void;
  disconnect: () => void;
  setConn: (c: ConnState) => void;

  checkSubscription: (url: string) => void;
  resetSubscription: () => void;
  finishOnboarding: (prefs?: OnboardingPrefs) => void;
  resetOnboarding: () => void;
  dismissIntro: () => void;
  /** Открыть быструю настройку повторно (без стирания подписки и правил). */
  openQuickSetup: () => void;
  /** Закрыть быструю настройку, ничего не меняя. */
  closeQuickSetup: () => void;

  setMode: (m: Mode) => void;
  setSmartRouting: (v: boolean) => void;
  setServer: (id: string) => void;
  setSetting: <K extends keyof Settings>(k: K, v: Settings[K]) => void;

  setAppRoute: (id: string, r: Route) => void;
  toggleApp: (id: string) => void;
  locateApp: (id: string, path: string) => void;
  addApp: (name: string, route: Route, processes?: string[]) => void;
  removeApp: (id: string) => void;

  setSiteRoute: (id: string, r: Route) => void;
  addSite: (domain: string, route: Route) => void;
  removeSite: (id: string) => void;
  /** Выключить/включить правило, не удаляя его. */
  toggleSite: (id: string) => void;
  /** Почему домен идёт туда, куда идёт: прогоняем его по тем же правилам, что
   *  уходят в движок. Нужно, когда сайт ведёт себя не так, как ожидалось. */
  explainDomain: (domain: string) => Promise<{ route: string; reason: string; matched: string } | null>;

  toggleList: (id: string) => void;
  syncNow: () => void;

  /** Текст последней ошибки движка или подписки. */
  error: string | null;
  /** Идёт автоматическое переподключение после обрыва. */
  reconnecting: boolean;
  /** У выбранного сервера есть профиль «Полный VPN» — тумблер умной можно выключить. */
  fullAvailable: boolean;
  /** Профиль, которым реально подключаемся (умный или полный). */
  selectedNode: Server | null;
}

const C = createContext<Ctx | null>(null);

/** Домен из того, что человек вставил: убираем схему, www, путь и порт. */
export function normalizeDomain(raw: string): string {
  let v = raw.trim().toLowerCase();
  v = v.replace(/^[a-z]+:\/\//, '');
  v = v.replace(/^www\./, '');
  v = v.split('/')[0].split('?')[0].split('#')[0].split(':')[0];
  return v;
}

function titleFromDomain(d: string): string {
  const head = d.split('.')[0] ?? d;
  return head.charAt(0).toUpperCase() + head.slice(1);
}

/** Правила в том виде, в каком их ждёт движок.

    Порядок важности задаётся составом, а не сортировкой: то, что человек выбрал
    сам, уходит отдельным списком и попадает в конфиг выше любых подгруженных
    правил. Иначе список российских сервисов молча отменял бы его выбор. */
export function rulesOf(s: State, srv: ServerLists | null) {
  const on = s.apps.filter((a) => a.enabled);
  const listsOn = (id: string) => s.lists.find((l) => l.id === id)?.enabled !== false;
  // Выключенное правило остаётся в списке, но в конфиг не идёт.
  const from = (src: SiteRule['source']) => s.sites.filter((v) => v.source === src && v.enabled !== false);

  // Браузер важнее окна: человек нажимал кнопку последним и прямо на сайте.
  const seen = new Set<string>();
  const userDomains: { domain: string; route: Route }[] = [];
  for (const v of [...from('browser'), ...from('manual')]) {
    if (seen.has(v.domain)) continue;
    seen.add(v.domain);
    userDomains.push({ domain: v.domain, route: v.route });
  }

  // Списки с сервера главнее встроенных: встроенные — лишь запас на случай,
  // когда синхронизация ещё не проходила.
  const list = from('list');
  const vpnFromLists = srv?.vpnDomains?.length
    ? srv.vpnDomains
    : list.filter((v) => v.route === 'vpn').map((v) => v.domain);
  const directFromLists = srv?.directDomains?.length
    ? [...DIRECT_DOMAINS, ...srv.directDomains]
    : [...DIRECT_DOMAINS, ...list.filter((v) => v.route === 'direct').map((v) => v.domain)];

  const node = nodeFor(s);
  const useLists = listsOn('sites');
  return {
    // Полный профиль — только когда сервер его выдал; иначе остаёмся умными.
    smart: effectiveSmart(s),
    lanAccess: lanAccessFor(s, node),
    tunnel: s.settings.tunnel,
    bypassLocal: s.settings.bypassLocal,
    customLocal: s.settings.customLocalDomains,
    // «Свой» DNS передаём как есть (адрес/URL); пустой откатываем на Cloudflare.
    dnsProvider:
      s.settings.dnsProvider === 'custom'
        ? s.settings.customDns.trim() || 'cloudflare'
        : s.settings.dnsProvider,
    userDomains,
    listVpnDomains: useLists ? vpnFromLists.filter((d) => !seen.has(d)) : [],
    // Остальные виды из грамматики upstream (контракт, раздел 7) — только с сервера.
    listVpnFull: useLists ? (srv?.vpnFull ?? []) : [],
    listVpnKeywords: useLists ? (srv?.vpnKeywords ?? []) : [],
    listVpnRegex: useLists ? (srv?.vpnRegex ?? []) : [],
    listVpnIps: useLists ? (srv?.vpnIps ?? []) : [],
    listDirectDomains: listsOn('direct') ? directFromLists.filter((d) => !seen.has(d)) : [],
    vpnProcesses: on.filter((a) => a.route === 'vpn').flatMap((a) => a.processes),
    directProcesses: on.filter((a) => a.route === 'direct').flatMap((a) => a.processes),
  };
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const start = fromUrl();
  const [s, setS] = useState<State>(start.s);
  const [nav, setNav] = useState<Nav>(start.nav);
  const [error, setError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  // Списки с сервера держим отдельно от состояния: они большие, приходят с
  // диска и сохранять их второй раз незачем.
  const [srv, setSrv] = useState<ServerLists | null>(null);
  const timers = useRef<number[]>([]);
  const loaded = useRef(false);

  const later = useCallback((fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  }, []);
  const clearTimers = useCallback(() => {
    timers.current.forEach(window.clearTimeout);
    timers.current = [];
  }, []);

  /* Число правил в списках берём из РЕАЛЬНО загруженных с сервера данных, а не
     из зашитого пресета: иначе «Недоступные ресурсы» показывали 46 вместо
     тысячи с лишним. Считаем по фактически подгруженному. */
  const applyListCounts = useCallback((sl: ServerLists) => {
    const byFile = new Map(sl.counts);
    setS((x) => ({
      ...x,
      lists: x.lists.map((l) => {
        let n: number | undefined;
        // «Недоступные ресурсы» = вся база AutoRoute: домены всех видов и подсети.
        if (l.id === 'sites')
          n = sl.vpnDomains.length + (sl.vpnFull?.length ?? 0) + (sl.vpnKeywords?.length ?? 0) + (sl.vpnRegex?.length ?? 0) + (sl.vpnIps?.length ?? 0);
        else if (l.id === 'apps') n = byFile.get('apps') ?? sl.apps.length;
        else if (l.id === 'direct') n = DIRECT_DOMAINS.length + sl.directDomains.length;
        const updated = l.id === 'sites' && sl.version != null ? `v${sl.version}` : l.updated;
        return n != null && n > 0 ? { ...l, rules: n, updated } : { ...l, updated };
      }),
    }));
  }, []);

  /* Ответ панели по контракту. Отказ (4xx) авторитетен: подключение блокируем,
     активную сессию гасим, причину показываем. «Не ответила» — не сигнал: живём
     по последней копии. */
  const applyMeta = useCallback((m: MetaResult) => {
    const meta = toMetaState(m);
    setS((x) => {
      const live = x.conn === 'on' || x.conn === 'config-updating' || x.conn === 'config-updated' || x.conn === 'connecting';
      if (meta.denied) {
        if (live && inTauri) void vpnDisconnect().catch(() => null);
        return { ...x, meta, conn: 'sub-invalid' };
      }
      // Доступ вернули — снимаем блок.
      const conn = x.conn === 'sub-invalid' ? 'off' : x.conn;
      return { ...x, meta, conn };
    });
    if (meta.denied) setError(meta.denied.message);
  }, []);

  /* ── Чтение с диска при запуске ─────────────────────────── */
  useEffect(() => {
    if (!inTauri) {
      loaded.current = true;
      return;
    }
    void (async () => {
      try {
        const saved = await stateLoad<Partial<State>>('state');
        if (saved) {
          setS((x) => ({
            ...x,
            ...saved,
            // Подключение при запуске всегда сброшено: движок ещё не поднят.
            conn: 'off',
            settings: { ...x.settings, ...(saved.settings ?? {}) },
          }));
        }
        const saved_lists = await listsLoad().catch(() => null);
        if (saved_lists) {
          setSrv(saved_lists);
          applyListCounts(saved_lists);
        }
        // Реальный статус приложений на ЭТОЙ машине: раньше «найдено» бралось
        // с чужой сборочной машины и врало (Obsidian/Spotify, которых нет).
        const [inst, run] = await Promise.all([
          appsInstalled().catch(() => []),
          appsRunning().catch(() => []),
        ]);
        const present = new Set<string>();
        for (const a of [...inst, ...run]) for (const pr of a.processes) present.add(pr.toLowerCase());
        const runningSet = new Set<string>();
        for (const a of run) for (const pr of a.processes) runningSet.add(pr.toLowerCase());
        setS((x) => ({
          ...x,
          apps: x.apps.map((a) => {
            const found = a.processes.some((pr) => present.has(pr.toLowerCase()));
            return { ...a, found, path: found ? a.path : undefined };
          }),
        }));
        // Серверы восстанавливаем из сохранённой подписки — без обращения к сети.
        const cached = await subCached().catch(() => null);
        if (cached?.servers?.length) {
          setS((x) => {
            const servers = cached.servers.map(toServer);
            const reps = representatives(servers);
            // Сохранённый выбор мог указывать на полный профиль — переводим на
            // представителя того же сервера, режим задаёт тумблер.
            const saved = servers.find((v) => v.id === x.serverId);
            const serverId = saved ? (reps.find((r) => serverKey(r) === serverKey(saved))?.id ?? saved.id) : reps[0]?.id ?? null;
            return {
              ...x,
              servers,
              serverId,
              subscription: { ...x.subscription, status: 'active', servers: reps.length },
            };
          });
          // Профили и режимы — с панели (или из кэша, если она не ответила).
          const m = await metaFetch().catch(() => null);
          if (m) applyMeta(m);
        }
        // Автообновление списков: тихо тянем свежие с сервера в фоне, чтобы
        // «Недоступные ресурсы» и прочие всегда отражали актуальные данные, а не
        // то, что было зашито в сборку. Только при включённой настройке и живой
        // подписке.
        const autoLists = saved?.settings?.autoUpdateLists ?? true;
        if (autoLists && cached?.servers?.length) {
          void listsSync()
            .then((r) => {
              setSrv(r);
              applyListCounts(r);
            })
            .catch(() => null);
        }
        // Автопроверка обновления приложения при запуске. Тумблер обещает
        // «Обновляться автоматически» — если на GitHub есть свежая подписанная
        // версия, тихо её ставим. updateInstall без обновления ничего не делает,
        // так что обычный запуск это не трогает.
        const autoUpdApp = saved?.settings?.autoUpdateApp ?? true;
        if (autoUpdApp) {
          void updateCheck()
            .then((info) => {
              if (info.available) void updateInstall().catch(() => null);
            })
            .catch(() => null);
        }
      } finally {
        loaded.current = true;
      }
    })();
  }, []);

  /* ── Запись на диск при изменениях ──────────────────────── */
  useEffect(() => {
    if (!inTauri || !loaded.current) return;
    const id = window.setTimeout(() => {
      const { servers: _drop, ...rest } = s;
      void stateSave('state', rest);
    }, 400);
    return () => window.clearTimeout(id);
  }, [s]);

  /* ── Правила, добавленные в браузере ────────────────────
     Расширение пишет их отдельным файлом, приложение подмешивает в свой
     список. Отдельный файл, а не общее состояние: писать из двух процессов в
     один файл — гонка, в которой чьи-то правки молча пропадут. */
  useEffect(() => {
    if (!inTauri) return;
    let stop = false;
    const tick = async () => {
      const rules = await browserRules().catch(() => null);
      if (stop || !rules) return;
      setS((x) => {
        const byDomain = new Map(rules.map((r) => [r.domain, r.route]));
        // Прежние правила из браузера, которых больше нет, убираем.
        const kept = x.sites.filter((v) => v.source !== 'browser' || byDomain.has(v.domain));
        let changed = kept.length !== x.sites.length;
        const next = kept.map((v) => {
          const route = byDomain.get(v.domain);
          if (!route || v.route === route) return v;
          changed = true;
          return { ...v, route, source: 'browser' as const };
        });
        for (const r of rules) {
          if (next.some((v) => v.domain === r.domain)) continue;
          changed = true;
          next.push({
            id: `b-${r.domain}`,
            title: r.domain,
            domain: r.domain,
            route: r.route,
            source: 'browser',
          });
        }
        return changed ? { ...x, sites: next } : x;
      });
    };
    void tick();
    const id = window.setInterval(tick, 1500);
    // Правило добавляют в БРАУЗЕРЕ, то есть окно приложения в этот момент скрыто, а
    // фоновому webview движок душит таймеры (Chromium — до раза в минуту). Поэтому
    // одного интервала мало: список «не обновлялся», пока не вернёшься к окну и не
    // потыкаешь вкладки. Перечитываем сразу, как только окно снова видно.
    const wake = () => {
      if (document.visibilityState === 'visible') void tick();
    };
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      stop = true;
      window.clearInterval(id);
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, []);

  /* ── Возврат с полного VPN на умный ────────────────────
     Человек включает полный режим «на разок» и забывает — дальше весь его трафик
     идёт через сервер. Сервер сам этого не исправит: он отдаёт два конфига и не
     знает, каким пользуются. Поэтому срок задаёт панель (meta.routing.
     fullTimeoutHours), а исполняем мы. 0 — не возвращать.

     Момент включения держим в ref, а не в состоянии: это факт текущего сеанса,
     переживать перезапуск ему незачем — после запуска отсчёт начинается заново. */
  const fullSince = useRef<number | null>(null);
  useEffect(() => {
    if (effectiveSmart(s)) {
      fullSince.current = null;
      return;
    }
    if (fullSince.current === null) fullSince.current = Date.now();
    const hours = nodeFor(s)?.profileId
      ? (s.meta?.profiles.find((p) => p.profileId === nodeFor(s)!.profileId)?.fullTimeoutHours ?? 0)
      : 0;
    if (!hours) return;
    const left = fullSince.current + hours * 3600_000 - Date.now();
    const id = window.setTimeout(() => {
      fullSince.current = null;
      setS((x) => ({ ...x, smartRouting: true }));
    }, Math.max(1000, left));
    return () => window.clearTimeout(id);
  }, [s.smartRouting, s.serverId, s.meta]);

  /* ── Здоровье движка и автопереподключение ─────────────
     Движок может упасть, а сервер — стать недоступным. Пока «Подключено», тихо
     проверяем, жив ли движок; если нет — пробуем поднять снова несколько раз.

     Важно: НЕ переводим conn в 'connecting' во время попыток — иначе этот же
     эффект (он завязан на conn) снёс бы сам себя, счётчик обнулился бы, а при
     неудачной попытке состояние застряло бы в 'connecting' навсегда. Держим
     conn='on', а факт переподключения показываем отдельным флагом. */
  const retries = useRef(0);
  // s и srv нужны свежими внутри интервала — держим в ref, чтобы не пересоздавать
  // интервал на каждый чих и не ловить устаревшее замыкание.
  const liveDeps = useRef({ s, srv });
  liveDeps.current = { s, srv };
  useEffect(() => {
    if (!inTauri || s.conn !== 'on') return;
    retries.current = 0;
    let stop = false;
    const id = window.setInterval(async () => {
      const alive = await vpnAlive().catch(() => true);
      if (stop || alive) {
        retries.current = 0;
        setReconnecting(false);
        return;
      }
      if (retries.current >= 3) {
        stop = true;
        window.clearInterval(id);
        setReconnecting(false);
        setError('Соединение потеряно. Не удалось восстановить.');
        // Возвращаем системный прокси: он указывает на уже мёртвый порт.
        if (inTauri) void vpnDisconnect().catch(() => null);
        setS((x) => (x.conn === 'on' ? { ...x, conn: 'error' } : x));
        return;
      }
      retries.current += 1;
      setReconnecting(true);
      try {
        const { s: cur, srv: sv } = liveDeps.current;
        await vpnConnect(nodeFor(cur)?.id ?? cur.serverId, rulesOf(cur, sv));
        // Пока мы поднимались, человек мог нажать «Отключить». Тогда движок
        // сейчас снова живой, а интерфейс показывает «Отключено» — гасим его,
        // иначе VPN тихо работал бы вопреки выбору пользователя.
        if (stop) {
          if (inTauri) void vpnDisconnect().catch(() => null);
          return;
        }
        retries.current = 0;
        setReconnecting(false);
      } catch {
        /* следующий тик попробует снова */
      }
    }, 4000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
    // Завязано только на факт «подключено», не на каждое изменение состояния.
  }, [s.conn]);

  /* ── Полный реконнект при смене режима адаптера ─────────
     Переключение proxy↔tunnel меняет системный прокси и требует прав — это не
     горячая подмена правил, а именно переподключение. */
  const prevTunnel = useRef(s.settings.tunnel);
  useEffect(() => {
    if (!inTauri || !loaded.current) return;
    if (prevTunnel.current === s.settings.tunnel) return;
    prevTunnel.current = s.settings.tunnel;
    // Автозапуск переключаем на нужный механизм: TUN → тихий elevated через
    // планировщик, прокси → обычный ключ реестра.
    void autostartSync(s.settings.autostart, s.settings.tunnel);
    if (s.conn === 'on' || s.conn === 'config-updated') {
      // Полный реконнект: vpnConnect сам проверит права и переставит прокси.
      setError(null);
      setS((x) => ({ ...x, conn: 'connecting' }));
      void vpnConnect(nodeFor(s)?.id ?? s.serverId, rulesOf(s, srv))
        .then(() => setS((x) => (x.conn === 'connecting' ? { ...x, conn: 'on' } : x)))
        .catch((e: unknown) => {
          setError(String(e));
          setS((x) => ({ ...x, conn: 'error' }));
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.settings.tunnel]);

  /* ── Применение правил на лету ──────────────────────────
     Добавленный сайт/правило применяется без разрыва соединения. Задержка
     сглаживает серию правок. Реагируем и на настройки, влияющие на правила
     (DNS, свои локальные домены, обход локальной сети). */
  const live = s.conn === 'on' || s.conn === 'config-updated';
  useEffect(() => {
    if (!inTauri || !loaded.current || !live) return;
    const id = window.setTimeout(() => {
      void vpnReload(nodeFor(s)?.id ?? s.serverId, rulesOf(s, srv)).catch((e: unknown) => setError(String(e)));
    }, 500);
    return () => window.clearTimeout(id);
  }, [
    live,
    s.apps,
    s.sites,
    s.lists,
    s.serverId,
    s.smartRouting,
    s.meta,
    s.settings.bypassLocal,
    s.settings.dnsProvider,
    s.settings.customLocalDomains,
    srv,
  ]);

  const api = useMemo<Ctx>(() => {
    const patch = (p: Partial<State>) => setS((x) => ({ ...x, ...p }));

    const doConnect = () => {
      clearTimers();
      setError(null);
      patch({ conn: 'connecting' });
      if (!inTauri) {
        later(() => patch({ conn: 'on' }), 1500);
        return;
      }
      // Отказ панели авторитетен: до валидного ответа не подключаемся вовсе.
      if (s.meta?.denied) {
        setError(s.meta.denied.message);
        patch({ conn: 'sub-invalid' });
        return;
      }
      void vpnConnect(nodeFor(s)?.id ?? s.serverId, rulesOf(s, srv))
        .then(() => patch({ conn: 'on' }))
        .catch((e: unknown) => {
          setError(String(e));
          patch({ conn: 'error' });
        });
    };

    const doDisconnect = () => {
      clearTimers();
      // Сбрасываем флаг переподключения: если человек нажал «Отключить» во время
      // авто-переподключения, иначе под «Отключено» так и висела бы надпись
      // «Переподключение…».
      setReconnecting(false);
      patch({ conn: 'off' });
      if (inTauri) void vpnDisconnect().catch(() => null);
    };

    return {
      s,
      nav,
      error,
      reconnecting,
      fullAvailable: fullAvailableFor(s),
      selectedNode: nodeFor(s),
      go: (tab) => setNav((n) => ({ ...n, tab })),
      goRouting: (routingTab) => setNav((n) => ({ ...n, routingTab })),
      setOnboardingStep: (onboardingStep) => setNav((n) => ({ ...n, onboardingStep })),

      connect: doConnect,
      disconnect: doDisconnect,
      setConn: (conn) => {
        clearTimers();
        patch({ conn });
      },

      checkSubscription: (url) => {
        clearTimers();
        setError(null);
        patch({ subscription: { url, status: 'checking', servers: 0 } });
        if (!inTauri) {
          const bad = url.includes('нет') || url.includes('invalid');
          later(
            () =>
              patch({
                subscription: bad
                  ? { url, status: 'invalid', servers: 0 }
                  : { url, status: 'active', servers: 2 },
              }),
            1200,
          );
          return;
        }
        void subFetch(url)
          .then(async (r) => {
            const servers = r.servers.map(toServer);
            const reps = representatives(servers);
            setS((x) => ({
              ...x,
              servers,
              serverId: x.serverId && reps.some((v) => v.id === x.serverId) ? x.serverId : reps[0]?.id ?? null,
              subscription: { url, status: 'active', servers: reps.length },
            }));
            // Профили и режимы — тем же токеном, что и подписка.
            const m = await metaFetch(url).catch(() => null);
            if (m) applyMeta(m);
          })
          .catch((e: unknown) => {
            setError(String(e));
            patch({ subscription: { url, status: 'invalid', servers: 0 } });
          });
      },
      resetSubscription: () => patch({ subscription: { url: '', status: 'none', servers: 0 } }),
      finishOnboarding: (prefs) => {
        // Выбор в онбординге теперь реально применяется, а не только рисуется.
        setS((x) => {
          const chosen = prefs?.appIds ? new Set(prefs.appIds) : null;
          // Приложения, показанные на экране настройки: их галочку применяем
          // точно (снятая = выключить). Прочие приложения не трогаем.
          const suggestedIds = new Set(SUGGESTED.map((a) => a.id));
          return {
            ...x,
            onboarded: true,
            smartRouting: prefs?.smart ?? x.smartRouting,
            apps: chosen
              ? x.apps.map((a) => (suggestedIds.has(a.id) ? { ...a, enabled: chosen.has(a.id) } : a))
              : x.apps,
            // Готовый список сайтов — по галочке.
            lists:
              prefs?.useList === undefined
                ? x.lists
                : x.lists.map((l) => (l.id === 'sites' ? { ...l, enabled: prefs.useList! } : l)),
            settings: {
              ...x.settings,
              autostart: prefs?.autostart ?? x.settings.autostart,
              autoUpdateLists: prefs?.autoUpdateLists ?? x.settings.autoUpdateLists,
              bypassLocal: prefs?.bypassLocal ?? x.settings.bypassLocal,
            },
          };
        });
        if (inTauri && prefs && prefs.autostart !== undefined) {
          // Режим адаптера быстрая настройка не трогает — сохраняем текущий,
          // иначе повторный проход снёс бы тихий elevated-автозапуск TUN.
          void autostartSync(prefs.autostart, s.settings.tunnel);
        }
        setNav({ tab: 'home', routingTab: 'apps', onboardingStep: 0, quickSetup: false });
      },
      openQuickSetup: () => setNav((n) => ({ ...n, quickSetup: true })),
      closeQuickSetup: () => setNav((n) => ({ ...n, quickSetup: false })),
      resetOnboarding: () => {
        clearTimers();
        if (inTauri) void vpnDisconnect().catch(() => null);
        setS({ ...INITIAL });
        setNav({ tab: 'home', routingTab: 'apps', onboardingStep: 0, quickSetup: false });
      },

      setMode: (mode) => patch({ mode }),
      dismissIntro: () => patch({ introSeen: true }),
      setSmartRouting: (smartRouting) => patch({ smartRouting }),
      setServer: (serverId) => patch({ serverId }),
      setSetting: (k, v) => setS((x) => ({ ...x, settings: { ...x.settings, [k]: v } })),

      setAppRoute: (id, route) =>
        setS((x) => ({ ...x, apps: x.apps.map((a) => (a.id === id ? { ...a, route } : a)) })),
      toggleApp: (id) =>
        setS((x) => ({
          ...x,
          apps: x.apps.map((a) => (a.id === id ? { ...a, enabled: !a.enabled } : a)),
        })),
      locateApp: (id, path) =>
        setS((x) => ({
          ...x,
          apps: x.apps.map((a) => {
            if (a.id !== id) return a;
            // Берём РЕАЛЬНЫЙ выбранный файл: и путь, и имя процесса (маршрутизация
            // идёт по PROCESS-NAME, поэтому процесс должен совпадать с выбранным exe).
            const exe = path.replace(/\\/g, '/').split('/').pop() || '';
            const processes = exe ? [exe] : a.processes;
            return { ...a, found: true, source: 'manual', path, processes };
          }),
        })),
      addApp: (name, route, processes) =>
        setS((x) => {
          const procs =
            processes && processes.length ? processes : [`${name.replace(/\s+/g, '')}.exe`];
          const procSet = new Set(procs.map((p) => p.toLowerCase()));
          // Уже есть правило с тем же процессом? Не плодим дубль — обновляем маршрут.
          const dupe = x.apps.find((a) => a.processes.some((p) => procSet.has(p.toLowerCase())));
          if (dupe) {
            return {
              ...x,
              apps: x.apps.map((a) =>
                a.id === dupe.id ? { ...a, route, enabled: true, found: true } : a,
              ),
            };
          }
          return {
            ...x,
            apps: [
              ...x.apps,
              { id: `a${Date.now()}`, name, route, enabled: true, found: true, source: 'manual', processes: procs },
            ],
          };
        }),
      removeApp: (id) => setS((x) => ({ ...x, apps: x.apps.filter((a) => a.id !== id) })),

      setSiteRoute: (id, route) =>
        setS((x) => ({ ...x, sites: x.sites.map((v) => (v.id === id ? { ...v, route } : v)) })),
      addSite: (raw, route) => {
        const domain = normalizeDomain(raw);
        if (!domain) return;
        setS((x) =>
          x.sites.some((v) => v.domain === domain)
            ? x
            : {
                ...x,
                sites: [
                  ...x.sites,
                  { id: `s${Date.now()}`, title: titleFromDomain(domain), domain, route, source: 'manual' },
                ],
              },
        );
      },
      removeSite: (id) => setS((x) => ({ ...x, sites: x.sites.filter((v) => v.id !== id) })),
      explainDomain: (domain) => explainDomain(domain, rulesOf(s, srv)),
      toggleSite: (id) =>
        setS((x) => ({
          ...x,
          sites: x.sites.map((v) => (v.id === id ? { ...v, enabled: v.enabled === false } : v)),
        })),

      toggleList: (id) =>
        setS((x) => ({
          ...x,
          lists: x.lists.map((l) => (l.id === id ? { ...l, enabled: !l.enabled } : l)),
        })),

      syncNow: () => {
        clearTimers();
        setError(null);
        const back = s.conn;
        // Состояния «обновление» переводят приложение в разряд «на связи» и
        // дёргают горячую подмену правил. Делать это, когда движок выключен,
        // нельзя: интерфейс мигал бы «подключено», а перезагрузка правил уходила
        // бы в мёртвый движок. Поэтому дэнс со статусом — только на живом
        // соединении; выключенным просто обновляем списки.
        const live = back === 'on' || back === 'config-updated';
        if (live) patch({ conn: 'config-updating' });
        const done = (ok: boolean) => {
          setS((x) => ({
            ...x,
            conn: live ? (ok ? 'config-updated' : back) : x.conn,
            syncedAgo: ok ? 'только что' : x.syncedAgo,
          }));
          if (live && ok) later(() => setS((x) => (x.conn === 'config-updated' ? { ...x, conn: back } : x)), 2000);
        };
        if (!inTauri) {
          later(() => done(true), 1200);
          return;
        }
        // Заодно перечитываем профили: полный могли выдать или отозвать.
        void metaFetch()
          .then((m) => applyMeta(m))
          .catch(() => null);
        void listsSync()
          .then((r) => {
            setSrv(r);
            applyListCounts(r);
            done(true);
          })
          .catch((e: unknown) => {
            setError(String(e));
            done(false);
          });
      },
    };
  }, [s, nav, error, reconnecting, srv, later, clearTimers, applyMeta]);

  // Автоподключение при запуске. Тумблер «Подключаться автоматически» обещает
  // поднять VPN сразу после старта — ждём, пока восстановится подписка и выбор
  // сервера, и один раз за сеанс дёргаем connect. Гвард не даёт повторов при
  // последующих рендерах и не мешает ручному «Отключить».
  const autoConnected = useRef(false);
  useEffect(() => {
    if (!inTauri || autoConnected.current) return;
    if (!s.settings.autoconnect) return;
    if (s.subscription.status !== 'active' || !s.serverId) return;
    if (s.conn !== 'off') return;
    if (s.meta?.denied) return;
    autoConnected.current = true;
    api.connect();
  }, [s.settings.autoconnect, s.subscription.status, s.serverId, s.conn, s.meta, api]);

  return <C.Provider value={api}>{children}</C.Provider>;
}

function toServer(r: {
  name: string;
  server: string;
  port: number;
  kind: string;
  profileId?: string | null;
  serverId?: string | null;
  mode?: 'smart' | 'full';
}): Server {
  return {
    id: r.name,
    name: r.name,
    host: r.server,
    port: r.port,
    kind: r.kind,
    profileId: r.profileId ?? null,
    serverId: r.serverId ?? null,
    mode: r.mode === 'full' ? 'full' : 'smart',
  };
}

export function useStore(): Ctx {
  const v = useContext(C);
  if (!v) throw new Error('useStore вызван вне StoreProvider');
  return v;
}
