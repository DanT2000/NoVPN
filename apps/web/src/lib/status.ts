// Вычисление статусов пользователя/устройства/сервера с цветами.
// Приоритеты и подписи — из дизайн-компонента (§7).

import type { Device, Server, User } from '@novpn/shared';
import { daysLeft } from './format';

export interface StatusView {
  key: string;
  label: string;
  fg: string;
  bg: string;
  dot: string;
}

const C = {
  green: { fg: 'var(--green-fg)', bg: 'var(--green-bg)', dot: 'var(--green-dot)' },
  amber: { fg: 'var(--amber-fg)', bg: 'var(--amber-bg)', dot: 'var(--amber-fg)' },
  red: { fg: 'var(--red-fg)', bg: 'var(--red-bg)', dot: 'var(--red-fg)' },
  gray: { fg: 'var(--gray-fg)', bg: 'var(--gray-bg)', dot: 'var(--gray-fg)' },
  blue: { fg: 'var(--blue-fg)', bg: 'var(--blue-bg)', dot: 'var(--blue-fg)' },
} as const;

/** Число активных устройств. С `protocol` — только этого протокола: лимит
 *  устройств относится ТОЛЬКО к AmneziaWG (у каждого свои ключи = устройство),
 *  а Xray — одна общая подписка на любое их число и в лимит не входит. */
export function countActiveDevices(userId: string, devices: Device[], protocol?: Device['protocol']): number {
  return devices.filter((d) => d.userId === userId && d.isActive && (protocol == null || d.protocol === protocol)).length;
}

type UserStatusInput = Pick<User, 'isActive' | 'expiresAt' | 'trafficLimitGb' | 'trafficUsedGb'>;

/** Статус пользователя (агрегат) — приоритет сверху вниз. Принимает и PublicUserView. */
export function statusOf(user: UserStatusInput): StatusView {
  if (!user.isActive) return { key: 'disabled', label: 'Отключён', ...C.gray };
  if (user.expiresAt && new Date(user.expiresAt).getTime() < Date.now())
    return { key: 'expired', label: 'Истёк', ...C.red };
  if (user.trafficLimitGb != null && user.trafficUsedGb >= user.trafficLimitGb)
    return { key: 'traffic', label: 'Лимит трафика', ...C.red };
  const dl = daysLeft(user.expiresAt);
  if (dl != null && dl <= 7) return { key: 'expiring', label: 'Истекает', ...C.amber };
  return { key: 'active', label: 'Активен', ...C.green };
}

/** Статус устройства — приоритет сверху вниз. */
export function devStatusOf(device: Device): StatusView {
  if (!device.isActive) return { key: 'disabled', label: 'Отключено', ...C.gray };
  // Без мониторинга активность неизвестна — не выдаём «Не подключалось» за факт.
  if (device.monitoringAvailable === false) return { key: 'monitoring_unavailable', label: 'Мониторинг недоступен', ...C.gray };
  if (!device.lastSeenAt) return { key: 'never', label: 'Не подключалось', ...C.gray };
  const days = (Date.now() - new Date(device.lastSeenAt).getTime()) / 86400000;
  if (days < 1) return { key: 'active', label: 'Активно', ...C.green };
  if (days < 7) return { key: 'recent', label: 'Недавно', ...C.blue };
  return { key: 'idle', label: 'Давно не использовалось', ...C.amber };
}

export function serverAgentView(server: Server): StatusView {
  // Панель управляет сервером по SSH (без агента на VPS) — показываем связь.
  return server.agent === 'online'
    ? { key: 'online', label: 'на связи', ...C.green }
    : { key: 'offline', label: 'нет связи', ...C.red };
}

export function serverEndpointView(server: Server): StatusView {
  return server.endpointOk
    ? { key: 'ok', label: 'доступен', ...C.green }
    : { key: 'down', label: 'нет ответа', ...C.red };
}

/** Ключ для фильтров списка пользователей. */
export function userFilterKey(user: User): 'active' | 'expiring' | 'exhausted' | 'disabled' {
  const s = statusOf(user);
  if (s.key === 'disabled') return 'disabled';
  if (s.key === 'expired' || s.key === 'traffic') return 'exhausted';
  if (s.key === 'expiring') return 'expiring';
  return 'active';
}
