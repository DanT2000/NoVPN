/* Стартовые данные приложения.
   Это уже не выдумка: приложения и домены взяты из готовых пресетов, собранных
   с реальной машины, а список российских доменов — из действующего конфига
   провайдера. Поэтому подключение с этими правилами сразу осмысленное. */

import appsPreset from '../data/apps.json';
import sitesPreset from '../data/sites.json';
import { lookup } from './catalog';
import type { AppRule, RuleList, Server, SiteRule, State } from '../state/types';

interface PresetApp {
  id: string;
  name: string;
  route: string;
  reason: string;
  processes: string[];
  installedOnSource: boolean;
}

interface PresetSite {
  domain: string;
  name: string | null;
  route: string;
  group: string;
}

const P_APPS = (appsPreset as { items: PresetApp[] }).items;
const P_SITES = (sitesPreset as { items: PresetSite[] }).items;

/** Серверы приходят из подписки; до её подключения список пуст. */
export const SERVERS: Server[] = [];

export const APPS: AppRule[] = P_APPS.map((a) => ({
  id: a.id,
  name: a.name,
  route: a.route === 'vpn' ? 'vpn' : 'direct',
  // Включаем сразу то, что нашлось на машине; остальное человек включит сам,
  // когда поставит.
  enabled: a.installedOnSource,
  found: a.installedOnSource,
  processes: a.processes,
  reason: a.reason,
  source: 'list',
}));

export const SITES: SiteRule[] = P_SITES.filter((v) => v.route === 'vpn').map((v, i) => ({
  id: `s${i}`,
  title: v.name ?? lookup(v.domain)?.name ?? v.domain,
  domain: v.domain,
  route: 'vpn',
  source: 'list',
}));

/** Домены, обязанные идти напрямую. Отдельным слоем: человеку их менять
    незачем, а правила из него сильнее всего остального. */
export const DIRECT_DOMAINS: string[] = P_SITES.filter((v) => v.route === 'direct').map(
  (v) => v.domain,
);

export const LISTS: RuleList[] = [
  {
    id: 'sites',
    name: 'Недоступные ресурсы',
    note: 'Сайты, которым нужен VPN',
    rules: P_SITES.filter((v) => v.route === 'vpn').length,
    updated: 'сегодня',
    enabled: true,
  },
  {
    id: 'direct',
    name: 'Российские сервисы',
    note: 'Ходят напрямую — иначе не пускают',
    rules: DIRECT_DOMAINS.length,
    updated: 'сегодня',
    enabled: true,
  },
  {
    id: 'apps',
    name: 'Приложения',
    note: 'Известные программы и их процессы',
    rules: P_APPS.length,
    updated: 'сегодня',
    enabled: true,
  },
];

/** Приложения, предлагаемые в первоначальной настройке. */
export const SUGGESTED = P_APPS.filter((a) => a.route === 'vpn' && a.installedOnSource)
  .slice(0, 5)
  .map((a) => ({ id: a.id, name: a.name, found: true }));

export const INITIAL: State = {
  onboarded: false,
  introSeen: false,
  subscription: { url: '', status: 'none', servers: 0 },
  conn: 'off',
  serverId: null,
  servers: SERVERS,
  smartRouting: true,
  mode: 'simple',
  apps: APPS,
  sites: SITES,
  lists: LISTS,
  syncedAgo: 'ещё не обновлялись',
  settings: {
    autostart: true,
    autoconnect: true,
    tray: true,
    autoUpdateLists: true,
    autoUpdateApp: true,
    tunnel: false,
    bypassLocal: false,
    customLocalDomains: [],
    dnsProvider: 'cloudflare',
    customDns: '',
    theme: 'system',
    uiScale: 'normal',
  },
};
