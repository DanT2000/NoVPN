// Русские подписи для машинных статусов. Используются в UI.

import type {
  ConfigSource,
  DeviceStatus,
  JobState,
  ManagementLevel,
  Protocol,
  UserAccessState,
} from './enums.js';

export const PROTOCOL_LABELS: Record<Protocol, string> = {
  xray: 'Xray',
  amneziawg: 'AmneziaWG',
  http: 'HTTP-прокси',
  socks5: 'SOCKS5',
};

export const DEVICE_STATUS_LABELS: Record<DeviceStatus, string> = {
  active_now: 'Активно сейчас',
  recently_used: 'Недавно использовалось',
  long_unused: 'Давно не использовалось',
  never_connected: 'Никогда не подключалось',
  disabled: 'Отключено',
  revoked: 'Отозвано',
  monitoring_unavailable: 'Мониторинг недоступен',
};

export const CONFIG_SOURCE_LABELS: Record<ConfigSource, string> = {
  legacy: 'Legacy (старый стек)',
  observed: 'Обнаружен',
  imported: 'Импортирован',
  unassigned: 'Не назначен',
  adopted: 'Принят',
  managed: 'Управляется NoVPN',
};

export const MANAGEMENT_LEVEL_LABELS: Record<ManagementLevel, string> = {
  managed: 'Полное управление',
  observed: 'Только наблюдение',
  unmanaged: 'Без управления',
};

export const USER_ACCESS_STATE_LABELS: Record<UserAccessState, string> = {
  active: 'Активен',
  disabled: 'Отключён',
  expired: 'Срок истёк',
  traffic_exhausted: 'Лимит трафика исчерпан',
};

export const JOB_STATE_LABELS: Record<JobState, string> = {
  queued: 'В очереди',
  running: 'Выполняется',
  succeeded: 'Готово',
  failed: 'Ошибка',
  canceled: 'Отменено',
};

/** Значение, которое показываем вместо нулевого трафика, если статистики нет. */
export const NO_MONITORING_TEXT = 'Мониторинг недоступен';
