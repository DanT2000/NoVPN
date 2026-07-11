// Перечисления и словари статусов NoVPN.
// Значения — стабильные машинные коды; человекочитаемые подписи (RU) — в labels.ts.

/** Протоколы. xray/amneziawg — для пользователей; http/https/socks5 — прокси (админ). */
export const PROTOCOLS = ['xray', 'amneziawg', 'http', 'https', 'socks5'] as const;
export type Protocol = (typeof PROTOCOLS)[number];

/** Протоколы, доступные обычным пользователям. */
export const USER_PROTOCOLS = ['xray', 'amneziawg'] as const;
export type UserProtocol = (typeof USER_PROTOCOLS)[number];

/** Политика сброса лимита трафика. */
export type ResetPolicy = 'monthly' | 'never';

/**
 * Три РАЗНЫХ сигнала состояния сервера — их нельзя смешивать:
 *  - agent: агент подключён к панели (control plane);
 *  - vpnService: VPN-служба на сервере здорова;
 *  - endpoint: публичный VPN-endpoint доступен снаружи.
 * Домашний сервер за NAT может иметь agent=online, но endpoint=unreachable.
 */
export type AgentConnectivity = 'online' | 'offline' | 'never';
export type ServiceHealth = 'healthy' | 'degraded' | 'down' | 'unknown';
export type EndpointReachability = 'reachable' | 'unreachable' | 'unknown';

/**
 * Источник конфига / уровень управления. Импортированные записи начинают
 * жизнь как observed/imported и могут быть adopted → managed.
 *  - legacy      — создан старым стеком, обслуживается им;
 *  - observed    — только обнаружен аудитом, панель им не управляет;
 *  - imported    — импортирован в БД панели (но управление ограничено);
 *  - unassigned  — импортирован, владелец не определён надёжно;
 *  - adopted     — сопоставлен и принят под управление, проверяется;
 *  - managed     — полностью управляется NoVPN.
 */
export const CONFIG_SOURCES = ['legacy', 'observed', 'imported', 'unassigned', 'adopted', 'managed'] as const;
export type ConfigSource = (typeof CONFIG_SOURCES)[number];

/** Насколько система реально может управлять записью. */
export type ManagementLevel = 'managed' | 'observed' | 'unmanaged';

/**
 * Статус устройства (одно устройство = один конфиг).
 *  - active_now            — активно сейчас;
 *  - recently_used         — недавно использовалось;
 *  - long_unused           — давно не использовалось;
 *  - never_connected       — никогда не подключалось;
 *  - disabled              — отключено;
 *  - revoked               — отозвано;
 *  - monitoring_unavailable — статистика недоступна (не показывать нули как факт).
 */
export const DEVICE_STATUSES = [
  'active_now',
  'recently_used',
  'long_unused',
  'never_connected',
  'disabled',
  'revoked',
  'monitoring_unavailable',
] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

/** Состояние доступа пользователя (агрегат). */
export const USER_ACCESS_STATES = ['active', 'disabled', 'expired', 'traffic_exhausted'] as const;
export type UserAccessState = (typeof USER_ACCESS_STATES)[number];

/** Режим работы Telegram-бота. */
export type TelegramMode = 'polling' | 'webhook';

/** Тип прокси для Telegram или админских proxy-доступов. */
export type ProxyType = 'http' | 'https' | 'socks5';

/** Состояние задания агента. */
export const JOB_STATES = ['queued', 'running', 'succeeded', 'failed', 'canceled'] as const;
export type JobState = (typeof JOB_STATES)[number];
