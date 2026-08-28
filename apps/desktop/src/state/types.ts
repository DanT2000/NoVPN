/* Модель данных прототипа NoVPN Desktop.
   Сетевой логики здесь нет — только то, что видит и трогает пользователь. */

/** Во всей пользовательской части маршрут ровно один из двух. Третьего нет. */
export type Route = 'vpn' | 'direct';

/** Состояния из раздела 17 ТЗ. Одно на всё приложение. */
export type ConnState =
  | 'off'
  | 'connecting'
  | 'on'
  | 'error'
  | 'no-internet'
  | 'sub-invalid'
  | 'config-updating'
  | 'config-updated';

export type Mode = 'simple' | 'advanced';
export type Theme = 'system' | 'dark' | 'light';
/** Масштаб интерфейса: окно фиксированной ширины, приблизить больше нечем. */
export type UiScale = 'normal' | 'large' | 'xlarge';
export type Tab = 'home' | 'routing' | 'connection' | 'settings';
export type RoutingTab = 'apps' | 'sites' | 'lists';

/** Сервер из подписки. Состав полей задаёт подписка, а не мы: у разных
    провайдеров она отдаёт разное, общее — только имя, адрес и порт. */
export interface Server {
  /** Совпадает с именем: в конфиге движка сервер выбирается именно по нему. */
  id: string;
  name: string;
  host: string;
  port: number;
  /** Протокол: vless, vmess, trojan, ss. */
  kind: string;
  /** Задержка. Появляется после замера, до него неизвестна. */
  ping?: number;
}

export interface AppRule {
  id: string;
  name: string;
  route: Route;
  enabled: boolean;
  /** Нашли ли исполняемый файл автоматически. */
  found: boolean;
  /** Имён процессов может быть несколько: у Discord их три. */
  processes: string[];
  path?: string;
  /** Почему приложению нужен VPN — показываем человеку вместо догадок. */
  reason?: string;
  source: 'auto' | 'manual' | 'list';
}

export interface SiteRule {
  id: string;
  /** Показываем человеку понятное имя, домен — второй строкой. */
  title: string;
  domain: string;
  route: Route;
  /** Откуда правило: из списка, руками в окне или из браузера. */
  source: 'manual' | 'list' | 'browser';
}

export interface RuleList {
  id: string;
  name: string;
  note: string;
  rules: number;
  updated: string;
  enabled: boolean;
}

export interface Subscription {
  url: string;
  status: 'none' | 'checking' | 'active' | 'invalid';
  servers: number;
}

export interface Settings {
  autostart: boolean;
  autoconnect: boolean;
  tray: boolean;
  autoUpdateLists: boolean;
  autoUpdateApp: boolean;
  /** Режим сетевого адаптера. Требует прав администратора, но только он
      позволяет управлять трафиком программ вроде Discord и Telegram. */
  tunnel: boolean;
  /** Обходить локальные домены (.local, .lan, corp…) напрямую. Выключено по
      умолчанию: у кого-то интранет должен идти через VPN. Подсети LAN идут
      напрямую всегда, независимо от этого. */
  bypassLocal: boolean;
  /** Свои локальные суффиксы (корпоративные домены) — всегда напрямую. */
  customLocalDomains: string[];
  /** Провайдер DNS-over-HTTPS. */
  dnsProvider: 'cloudflare' | 'google' | 'quad9' | 'custom';
  /** Свой DNS-сервер (DoH-URL или адрес), когда dnsProvider === 'custom'. */
  customDns: string;
  theme: Theme;
  uiScale: UiScale;
}

export interface State {
  onboarded: boolean;
  subscription: Subscription;
  conn: ConnState;
  serverId: string | null;
  servers: Server[];
  smartRouting: boolean;
  mode: Mode;
  apps: AppRule[];
  sites: SiteRule[];
  lists: RuleList[];
  syncedAgo: string;
  settings: Settings;
}
