// Контракты API. Один источник истины для фронтенда (api-клиент)
// и backend (роуты). Соответствуют будущим endpoint'ам.

import type { AppClient, BootstrapData, Device, PublicServerView, User } from './types.js';
import type { Protocol } from './enums.js';

export interface ApiError {
  type:
    | 'not_found'
    | 'disabled'
    | 'expired'
    | 'traffic'
    | 'devices'
    | 'rate_limited'
    | 'validation'
    | 'unauthorized'
    | 'server';
  message: string;
}

/** POST /api/public/check-code */
export interface CheckCodeRequest {
  code: string;
}
export type CheckCodeResult = { user: PublicUserView } | { error: ApiError };

/** Урезанное представление пользователя для публичной страницы. */
export interface PublicUserView {
  id: string;
  name: string;
  code: string;
  deviceLimit: number | null;
  expiresAt: string | null;
  trafficLimitGb: number | null;
  trafficUsedGb: number;
  allowedServers: string[];
  defaultServerId: string | null;
  allowedProtocols: Array<'xray' | 'amneziawg'>;
  isActive: boolean;
  telegramLinked: boolean;
  /** До какого момента работает вход по коду. null = вход по коду недоступен,
   *  человек пользуется личной ссылкой. Нужно, чтобы предупредить о переходе. */
  codeLoginUntil: string | null;
}

/** Ответ GET /api/public/bootstrap — данные публичной части сайта.
 *  `user` и `devices` непусты только когда в сессии есть вход по коду,
 *  и содержат ТОЛЬКО данные этого пользователя: чужие коды и конфиги
 *  наружу не отдаются никогда. */
export interface PublicBootstrapData {
  user: PublicUserView | null;
  devices: Device[];
  servers: PublicServerView[];
  apps: AppClient[];
  telegram: { enabled: boolean; botUsername: string | null };
  /** Готовая ссылка «Привязать Telegram» для вошедшего пользователя (deep-link
   *  с его токеном). null, если бот не настроен или нет входа. */
  botLink: string | null;
  /** Ссылка-подписка Xray: добавляется в приложение один раз, дальше оно само
   *  подтягивает все конфиги пользователя. null, если нет входа. */
  subLink: string | null;
}

/** POST /api/public/devices — выпуск конфига (одно устройство = один конфиг). */
export interface IssueDeviceRequest {
  userId: string;
  name: string;
  serverId: string;
  protocol: Protocol;
}
export interface IssueDeviceResult {
  device: Device;
  /** Для xray — импортируемая vless-ссылка. */
  link?: string;
  /** Для amneziawg — текст .conf. */
  conf?: string;
  /** Настоящий официальный ключ vpn:// доступен? */
  vpnKeyAvailable?: boolean;
  /** Ключ vpn:// (только если vpnKeyAvailable). */
  vpnKey?: string;
  /** Пояснение-ограничение, если vpn:// недоступен. */
  vpnKeyNote?: string;
}

/** Пункт read-only аудита сервера. */
export interface AuditItem {
  name: string;
  ok: boolean;
  note: string;
}

/** POST /api/admin/servers/test-ssh */
export interface TestServerConnectionResult {
  ok: boolean;
  audit: AuditItem[];
  message?: string;
}

/** POST /api/admin/telegram/test */
export interface TestTelegramResult {
  ok: boolean;
  message: string;
}

/** GET /api/bootstrap */
export type BootstrapResponse = BootstrapData;

/**
 * Интерфейс, который реализуют оба адаптера: mock (фронтенд без backend)
 * и real (HTTP-клиент к API). Компоненты зависят только от него.
 */
export interface NoVpnApi {
  getInitialData(): Promise<BootstrapData>;
  checkCode(code: string): Promise<CheckCodeResult>;
  issueDevice(req: IssueDeviceRequest): Promise<IssueDeviceResult>;
  testServerConnection(input: unknown): Promise<TestServerConnectionResult>;
  testTelegram(token: string): Promise<TestTelegramResult>;
}

export type { User, Device };
