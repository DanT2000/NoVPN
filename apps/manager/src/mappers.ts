// Преобразование строк БД ↔ доменные типы @novpn/shared.

import type { AppClient, Device, Server, User } from '@novpn/shared';
import { decConf } from './lib/crypto.js';

const j = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== 'string') return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};
const b = (v: unknown): boolean => v === 1 || v === true;

export function rowToUser(r: any): User {
  return {
    id: r.id,
    name: r.name,
    comment: r.comment ?? '',
    category: r.category ?? null,
    tags: j<string[]>(r.tags, []),
    code: r.code,
    accessToken: r.access_token ?? null,
    codeLoginUntil: r.code_login_until ?? null,
    deviceLimit: r.device_limit ?? null,
    expiresAt: r.expires_at ?? null,
    trafficLimitGb: r.traffic_limit_gb ?? null,
    trafficUsedGb: r.traffic_used_gb ?? 0,
    resetPolicy: r.reset_policy === 'monthly' ? 'monthly' : 'never',
    allowedServers: j<string[]>(r.allowed_servers, []),
    allowedProtocols: j<Array<'xray' | 'amneziawg'>>(r.allowed_protocols, ['xray']),
    allowedProxies: j<Array<'http' | 'https' | 'socks5'>>(r.allowed_proxies, []),
    isActive: b(r.is_active),
    telegram: r.telegram ?? null,
    createdAt: r.created_at,
    lastActivityAt: r.last_activity_at ?? null,
  };
}

export function rowToDevice(r: any): Device {
  return {
    id: r.id,
    userId: r.user_id ?? null,
    name: r.name,
    serverId: r.server_id,
    protocol: r.protocol,
    isActive: b(r.is_active),
    lastSeenAt: r.last_seen_at ?? null,
    trafficGb: r.traffic_gb ?? 0,
    createdAt: r.created_at,
    osHint: r.os_hint ?? null,
    source: r.source ?? 'managed',
    managementLevel: r.management_level ?? 'managed',
    monitoringAvailable: b(r.monitoring_available),
    link: r.link ?? null,
    // conf хранится в БД зашифрованным (AES-GCM) — расшифровываем при чтении, чтобы
    // кабинет/бот копировали и скачивали обычный текст. Старый открытый conf — как есть.
    conf: decConf(r.conf),
  };
}

export function rowToServer(r: any): Server {
  return {
    id: r.id,
    name: r.name,
    country: r.country ?? null,
    host: r.host,
    agent: r.agent ?? 'never',
    endpointOk: b(r.endpoint_ok),
    serviceHealth: r.service_health ?? 'unknown',
    protocols: j<Server['protocols']>(r.protocols, []),
    trafficGb: r.traffic_gb ?? 0,
    users: r.users ?? 0,
    isDefault: b(r.is_default),
    autoIssue: b(r.auto_issue),
    lastSyncAt: r.last_sync_at ?? null,
    recommended: b(r.recommended),
    agentVersion: r.agent_version ?? null,
    detached: b(r.detached),
    sshKeyAuth: !!r.ssh_key_enc,
    flagEmoji: r.flag_emoji ?? null,
  };
}

export function rowToApp(r: any): AppClient {
  const d = j<Partial<AppClient>>(r.data, {});
  return {
    id: r.id,
    client: d.client ?? '',
    compat: d.compat ?? [],
    source: d.source ?? '',
    instruction: d.instruction ?? '',
    enabled: d.enabled ?? true,
    icon: d.icon ?? null,
    // Схема импорта подписки — без неё кнопка «Добавить подписку» не появится.
    urlScheme: d.urlScheme ?? null,
    platforms: Array.isArray(d.platforms) ? d.platforms : [],
  };
}
