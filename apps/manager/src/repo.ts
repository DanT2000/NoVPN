// Слой доступа к данным + сборка bootstrap. Единственное место SQL-запросов.

import crypto from 'node:crypto';
import type {
  AppClient,
  AppSettings,
  BootstrapData,
  Device,
  JobError,
  LogEntry,
  ProxyAccount,
  ProxyEndpoint,
  ProxyType,
  PublicBootstrapData,
  PublicUserView,
  Server,
  TelegramSettings,
  User,
} from '@novpn/shared';
import { config } from './config.js';
import { db, getSetting, setSetting } from './db.js';
import { decryptSecret, encConf } from './lib/crypto.js';
import { rowToApp, rowToDevice, rowToServer, rowToUser } from './mappers.js';
import { vpnLinkFromConf } from './services/amneziaLink.js';
import { checkDbIsolation } from './services/dbHealth.js';
import { isDefaultAdminPassword } from './services/adminAuth.js';
import { getServerProxy } from './services/keyvault.js';

export const nowIso = () => new Date().toISOString();
export const newId = (prefix: string) => `${prefix}_${crypto.randomBytes(6).toString('base64url')}`;

// ── users ──
export function listUsers(): User[] {
  return (db.prepare('SELECT * FROM users WHERE deleted_at IS NULL ORDER BY created_at DESC').all() as any[]).map(rowToUser);
}
export function getUser(id: string): User | null {
  const r = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(id) as any;
  return r ? rowToUser(r) : null;
}
export function getUserByCode(code: string): User | null {
  const r = db.prepare('SELECT * FROM users WHERE code = ? AND deleted_at IS NULL').get(code) as any;
  return r ? rowToUser(r) : null;
}

/** Пользователь по токену личной ссылки. Основной способ входа. */
export function getUserByAccessToken(token: string): User | null {
  const r = db.prepare('SELECT * FROM users WHERE access_token = ? AND deleted_at IS NULL').get(token) as any;
  return r ? rowToUser(r) : null;
}
/** Пользователь по токену подписки Xray. */
export function getUserBySubToken(token: string): User | null {
  const r = db.prepare('SELECT * FROM users WHERE sub_token = ? AND deleted_at IS NULL').get(token) as any;
  return r ? rowToUser(r) : null;
}
export function getSubToken(userId: string): string | null {
  const r = db.prepare('SELECT sub_token FROM users WHERE id = ?').get(userId) as { sub_token: string | null } | undefined;
  return r?.sub_token ?? null;
}

export function getAccessToken(userId: string): string | null {
  const r = db.prepare('SELECT access_token FROM users WHERE id = ?').get(userId) as { access_token: string | null } | undefined;
  return r?.access_token ?? null;
}
/** До какого момента пользователю разрешён вход по 6-значному коду.
 *  NULL = вход по коду недоступен (так у всех, кого завели после перехода на ссылки). */
export function getCodeLoginUntil(userId: string): string | null {
  const r = db.prepare('SELECT code_login_until FROM users WHERE id = ?').get(userId) as { code_login_until: string | null } | undefined;
  return r?.code_login_until ?? null;
}
/** Выдать пользователю новую личную ссылку (старая сразу перестаёт работать). */
export function resetAccessToken(userId: string): string {
  const token = crypto.randomBytes(18).toString('base64url');
  db.prepare('UPDATE users SET access_token = ?, updated_at = ? WHERE id = ?').run(token, nowIso(), userId);
  return token;
}
export function codeExists(code: string, exceptId?: string): boolean {
  const r = db.prepare('SELECT id FROM users WHERE code = ? AND deleted_at IS NULL').get(code) as any;
  return !!r && r.id !== exceptId;
}
export function genUniqueCode(): string {
  let c: string;
  do {
    c = String(100000 + crypto.randomInt(900000));
  } while (codeExists(c));
  return c;
}

export interface NewUserRow {
  name: string;
  comment: string;
  category: string | null;
  tags: string[];
  code: string;
  deviceLimit: number | null;
  expiresAt: string | null;
  trafficLimitGb: number | null;
  resetPolicy: 'never' | 'monthly';
  allowedServers: string[];
  defaultServerId: string | null;
  allowedProtocols: Array<'xray' | 'amneziawg'>;
  allowedProxies?: Array<'http' | 'https' | 'socks5'>;
  /** Разрешить вход по коду. По умолчанию нет — основной способ это личная ссылка. */
  codeLoginEnabled?: boolean;
}

// «Бессрочно включено» для входа по коду. Сравнение в check-code — до этой даты.
export const CODE_LOGIN_FOREVER = '2999-01-01T00:00:00.000Z';

/** Срок жизни входа по коду из настроек: now + codeLoginDays (0 = бессрочно). */
function codeLoginUntilFromSettings(): string {
  const days = Number(getSettings()?.codeLoginDays ?? 15);
  return days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : CODE_LOGIN_FOREVER;
}

export function insertUser(u: NewUserRow): User {
  const id = newId('u');
  const now = nowIso();
  db.prepare(
    `INSERT INTO users(id,name,comment,category,tags,code,device_limit,expires_at,traffic_limit_gb,traffic_used_gb,
      reset_policy,allowed_servers,default_server_id,allowed_protocols,allowed_proxies,is_active,telegram,created_at,updated_at,
      access_token,code_login_until,sub_token)
     VALUES(@id,@name,@comment,@category,@tags,@code,@device_limit,@expires_at,@traffic_limit_gb,0,
      @reset_policy,@allowed_servers,@default_server_id,@allowed_protocols,@allowed_proxies,1,NULL,@now,@now,
      @access_token,@code_login_until,@sub_token)`,
  ).run({
    id, name: u.name, comment: u.comment, category: u.category, tags: JSON.stringify(u.tags), code: u.code,
    device_limit: u.deviceLimit, expires_at: u.expiresAt, traffic_limit_gb: u.trafficLimitGb,
    reset_policy: u.resetPolicy, allowed_servers: JSON.stringify(u.allowedServers),
    default_server_id: u.defaultServerId, allowed_protocols: JSON.stringify(u.allowedProtocols),
    allowed_proxies: JSON.stringify(u.allowedProxies ?? []), now,
    // Личная ссылка выдаётся сразу. Вход по коду — только если админ включил.
    access_token: crypto.randomBytes(18).toString('base64url'),
    code_login_until: u.codeLoginEnabled ? codeLoginUntilFromSettings() : null,
    sub_token: crypto.randomBytes(18).toString('base64url'),
  });
  return getUser(id)!;
}

/** Включить/выключить вход по коду для пользователя.
 *  При включении срок берётся из настроек (codeLoginDays): через столько дней
 *  вход по коду сам отключится. 0 = без срока. */
export function setCodeLogin(userId: string, enabled: boolean): void {
  let until: string | null = null;
  if (enabled) {
    const days = Number(getSettings()?.codeLoginDays ?? 15);
    until = days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : CODE_LOGIN_FOREVER;
  }
  db.prepare('UPDATE users SET code_login_until = ?, updated_at = ? WHERE id = ?').run(until, nowIso(), userId);
}

export function updateUserFields(id: string, fields: Record<string, unknown>): User | null {
  const cols = Object.keys(fields);
  if (cols.length) {
    const set = cols.map((c) => `${c} = @${c}`).join(', ');
    db.prepare(`UPDATE users SET ${set}, updated_at = @updated_at WHERE id = @id`).run({ ...fields, id, updated_at: nowIso() });
  }
  return getUser(id);
}
export function softDeleteUser(id: string): void {
  db.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').run(nowIso(), id);
  // Базовое состояние: доступ снят, серверный отзыв ОЖИДАЕТ подтверждения. revoked_at
  // (таймер автоочистки) НЕ ставим здесь — его выставит вызывающий только тем
  // устройствам, чей отзыв на сервере подтверждён (revokeUserAccessOnServers). Иначе
  // при недоступном сервере запись удалилась бы через 3 дня, осиротив живой конфиг.
  db.prepare('UPDATE devices SET is_active = 0, revoke_pending = 1, revoked_at = NULL WHERE user_id = ? AND is_active = 1').run(id);
  // Прокси-логины пользователя тоже гасим (раньше оставались is_active=1 навсегда).
  db.prepare('UPDATE proxy_accounts SET is_active = 0 WHERE user_id = ? AND is_active = 1').run(id);
}

/** Пометить отзыв устройства ПОДТВЕРЖДЁННЫМ. Для удаления пользователя (forCleanup)
 *  ставим revoked_at — запись очистится через grace-период; для приостановки —
 *  оставляем revoked_at пустым (конфиг переживёт паузу до реактивации). */
export function markDeviceRevokeConfirmed(id: string, forCleanup: boolean): void {
  db.prepare('UPDATE devices SET is_active = 0, revoke_pending = 0, revoked_at = ? WHERE id = ?').run(
    forCleanup ? nowIso() : null,
    id,
  );
}

/** Устройства с ожидающим серверным отзывом (сервер был недоступен) — sync повторит.
 *  pending=1 → после подтверждения ставится revoked_at (автоочистка); pending=2 →
 *  приостановка: отзыв подтверждаем, но запись храним (переживёт до реактивации). */
export function listRevokePendingDevices(): Array<{
  id: string; userId: string | null; protocol: string; uuid: string | null; publicKey: string | null; serverId: string; pending: number;
}> {
  return db
    .prepare(
      'SELECT id, user_id AS userId, protocol, uuid, public_key AS publicKey, server_id AS serverId, revoke_pending AS pending FROM devices WHERE revoke_pending != 0',
    )
    .all() as Array<{ id: string; userId: string | null; protocol: string; uuid: string | null; publicKey: string | null; serverId: string; pending: number }>;
}

// ── devices ──
export function listDevices(): Device[] {
  return (db.prepare('SELECT * FROM devices ORDER BY created_at DESC').all() as any[]).map(rowToDevice);
}
export function getDevice(id: string): Device | null {
  const r = db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as any;
  return r ? rowToDevice(r) : null;
}
/** Сырая строка устройства (с uuid/public_key) — для отзыва на сервере. */
export function getDeviceRow(
  id: string,
): { uuid: string | null; public_key: string | null; protocol: string; server_id: string; revoke_pending: number } | null {
  return (db.prepare('SELECT uuid, public_key, protocol, server_id, revoke_pending FROM devices WHERE id = ?').get(id) as any) ?? null;
}
export function countActiveDevices(userId: string, protocol?: string): number {
  const sql = protocol
    ? 'SELECT COUNT(*) AS n FROM devices WHERE user_id = ? AND is_active = 1 AND protocol = ?'
    : 'SELECT COUNT(*) AS n FROM devices WHERE user_id = ? AND is_active = 1';
  const args = protocol ? [userId, protocol] : [userId];
  return (db.prepare(sql).get(...args) as { n: number }).n;
}

/** Активный Xray-конфиг пользователя на сервере (одна конфигурация работает на
 *  любом числе устройств — не плодим по конфигу на устройство). null, если нет. */
export function findActiveXrayDevice(userId: string, serverId: string): Device | null {
  const r = db
    .prepare("SELECT id FROM devices WHERE user_id = ? AND server_id = ? AND protocol = 'xray' AND is_active = 1 ORDER BY created_at DESC LIMIT 1")
    .get(userId, serverId) as { id: string } | undefined;
  return r ? getDevice(r.id) : null;
}

// ── прокси-аккаунты (per-user логин на сервере) ──
const PROXY_TYPES: ProxyType[] = ['http', 'https', 'socks5'];

interface ProxyRow {
  id: string;
  user_id: string | null;
  server_id: string;
  login: string;
  pass_enc: string;
  is_active: number;
  created_at: string;
  received_bytes?: number;
  sent_bytes?: number;
  rx_raw?: number;
  last_seen_at?: string | null;
}

export function findActiveProxyAccount(userId: string, serverId: string): ProxyRow | null {
  return (
    (db
      .prepare('SELECT * FROM proxy_accounts WHERE user_id = ? AND server_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1')
      .get(userId, serverId) as ProxyRow | undefined) ?? null
  );
}
export function getProxyAccountRow(id: string): ProxyRow | null {
  return (db.prepare('SELECT * FROM proxy_accounts WHERE id = ?').get(id) as ProxyRow | undefined) ?? null;
}
export function insertProxyAccountRow(d: { userId: string; serverId: string; login: string; passEnc: string }): ProxyRow {
  const id = newId('px');
  db.prepare('INSERT INTO proxy_accounts(id,user_id,server_id,login,pass_enc,is_active,created_at) VALUES(?,?,?,?,?,1,?)').run(
    id,
    d.userId,
    d.serverId,
    d.login,
    d.passEnc,
    nowIso(),
  );
  return getProxyAccountRow(id)!;
}
export function deactivateProxyAccount(id: string): void {
  db.prepare('UPDATE proxy_accounts SET is_active = 0 WHERE id = ?').run(id);
}
/** Активные прокси-аккаунты пользователей, исчерпавших квоту трафика — их логины
 *  надо погасить на сервере (иначе сохранённые creds работали бы сверх лимита). */
export function listProxyAccountsOverQuota(): Array<{ id: string; login: string; serverId: string }> {
  return db
    .prepare(
      `SELECT p.id AS id, p.login AS login, p.server_id AS serverId
         FROM proxy_accounts p JOIN users u ON u.id = p.user_id
        WHERE p.is_active = 1 AND u.deleted_at IS NULL
          AND u.traffic_limit_gb IS NOT NULL AND u.traffic_used_gb >= u.traffic_limit_gb`,
    )
    .all() as Array<{ id: string; login: string; serverId: string }>;
}
/** Устройства (AWG/Xray) пользователей, ИСЧЕРПАВШИХ квоту — их пир/uuid надо снять с
 *  сервера (иначе уже импортированный конфиг тоннелит сверх лимита). Ключи/запись в
 *  БД сохраняются (quota_blocked=1) — при восстановлении лимита пир вернётся без reissue. */
export function listDevicesToBlockForQuota(): Array<{ id: string; serverId: string; protocol: string }> {
  return db
    .prepare(
      `SELECT d.id AS id, d.server_id AS serverId, d.protocol AS protocol
         FROM devices d JOIN users u ON u.id = d.user_id
        WHERE d.is_active = 1 AND d.quota_blocked = 0 AND u.deleted_at IS NULL
          AND d.protocol IN ('xray','amneziawg')
          AND u.traffic_limit_gb IS NOT NULL AND u.traffic_used_gb >= u.traffic_limit_gb`,
    )
    .all() as Array<{ id: string; serverId: string; protocol: string }>;
}
/** Устройства, снятые по квоте (quota_blocked=1), чей пользователь СНОВА под лимитом —
 *  вернуть пир на сервер (тем же ключом → клиентский .conf работает без изменений). */
export function listDevicesToRestoreFromQuota(): Array<{
  id: string; serverId: string; name: string; protocol: string; uuid: string | null; awgPub: string | null; clientIp: string | null; psk: string | null;
}> {
  const rows = db
    .prepare(
      `SELECT d.id AS id, d.server_id AS serverId, d.name AS name, d.protocol AS protocol, d.uuid AS uuid,
              d.public_key AS awgPub, d.client_ip AS clientIp, d.preshared_key_enc AS pskEnc
         FROM devices d JOIN users u ON u.id = d.user_id
        WHERE d.quota_blocked = 1 AND d.is_active = 1 AND u.deleted_at IS NULL AND u.is_active = 1
          AND (u.traffic_limit_gb IS NULL OR u.traffic_used_gb < u.traffic_limit_gb)`,
    )
    .all() as Array<{ id: string; serverId: string; name: string; protocol: string; uuid: string | null; awgPub: string | null; clientIp: string | null; pskEnc: string | null }>;
  return rows.map((r) => ({
    id: r.id, serverId: r.serverId, name: r.name, protocol: r.protocol, uuid: r.uuid, awgPub: r.awgPub,
    clientIp: r.clientIp, psk: r.pskEnc ? decryptSecret(r.pskEnc) : null,
  }));
}
export function setQuotaBlocked(id: string, blocked: boolean): void {
  db.prepare('UPDATE devices SET quota_blocked = ? WHERE id = ?').run(blocked ? 1 : 0, id);
}

/** Деактивировать ВСЕ прокси-аккаунты пользователя (при отключении/удалении). */
export function deactivateUserProxyAccounts(userId: string): void {
  db.prepare('UPDATE proxy_accounts SET is_active = 0 WHERE user_id = ? AND is_active = 1').run(userId);
}
export function listProxyAccountRowsOfUser(userId: string): ProxyRow[] {
  return db.prepare('SELECT * FROM proxy_accounts WHERE user_id = ? AND is_active = 1 ORDER BY created_at DESC').all(userId) as ProxyRow[];
}
/** Активные прокси-аккаунты сервера — для сопоставления логина с трафиком в sync. */
export function listServerProxyAccounts(serverId: string): ProxyRow[] {
  return db.prepare('SELECT * FROM proxy_accounts WHERE server_id = ? AND is_active = 1').all(serverId) as ProxyRow[];
}
export function getProxyCounters(id: string): { total: number; rxRaw: number } {
  const r = db.prepare('SELECT received_bytes, sent_bytes, rx_raw FROM proxy_accounts WHERE id = ?').get(id) as
    | { received_bytes: number | null; sent_bytes: number | null; rx_raw: number | null }
    | undefined;
  return { total: (r?.received_bytes ?? 0) + (r?.sent_bytes ?? 0), rxRaw: r?.rx_raw ?? 0 };
}
export function updateProxyAccountTraffic(id: string, f: { receivedBytes: number; sentBytes: number; rxRaw: number; lastSeenAt?: string }): void {
  db.prepare(
    'UPDATE proxy_accounts SET received_bytes = ?, sent_bytes = ?, rx_raw = ?' +
      (f.lastSeenAt ? ', last_seen_at = ?' : '') +
      ' WHERE id = ?',
  ).run(...(f.lastSeenAt ? [f.receivedBytes, f.sentBytes, f.rxRaw, f.lastSeenAt, id] : [f.receivedBytes, f.sentBytes, f.rxRaw, id]));
}

/** Доступные пользователю на сервере типы прокси = разрешено пользователю ∩
 *  реально установлено на сервере. */
export function availableProxyTypes(user: User, server: Server): ProxyType[] {
  const allow = new Set(user.allowedProxies);
  const inst = new Set(server.protocols as string[]);
  return PROXY_TYPES.filter((t) => allow.has(t) && inst.has(t));
}

/** Собрать ProxyAccount для показа владельцу/админу: пароль расшифрован (у прокси
 *  он нужен для подключения), эндпоинты — по портам сервера ∩ типам пользователя. */
export function buildProxyAccountView(row: ProxyRow): ProxyAccount | null {
  const server = getServer(row.server_id);
  if (!server) return null;
  const user = row.user_id ? getUser(row.user_id) : null;
  const px = getServerProxy(server.host);
  const allow = new Set<ProxyType>(user ? user.allowedProxies : PROXY_TYPES);
  const endpoints: ProxyEndpoint[] = [];
  if (px) {
    if (px.httpPort && allow.has('http')) endpoints.push({ type: 'http', host: server.host, port: px.httpPort });
    if (px.socksPort && allow.has('socks5')) endpoints.push({ type: 'socks5', host: server.host, port: px.socksPort });
    if (px.httpsPort && allow.has('https')) endpoints.push({ type: 'https', host: px.httpsHost || server.host, port: px.httpsPort });
  }
  return {
    id: row.id,
    userId: row.user_id ?? null,
    serverId: server.id,
    serverName: server.name,
    serverHost: server.host,
    login: row.login,
    password: decryptSecret(row.pass_enc),
    endpoints,
    trafficGb: ((row.received_bytes ?? 0) + (row.sent_bytes ?? 0)) / 1e9,
    lastSeenAt: row.last_seen_at ?? null,
    isActive: !!row.is_active,
    createdAt: row.created_at,
  };
}

/** Прокси-аккаунты пользователя как готовые view (для кабинета). */
export function listProxyAccountsOfUser(userId: string): ProxyAccount[] {
  return listProxyAccountRowsOfUser(userId)
    .map((r) => buildProxyAccountView(r))
    .filter((x): x is ProxyAccount => x !== null);
}
// Устройства сервера с ключами — для синхронизации трафика. Берём ВСЕ (в т.ч.
// отозванные, но не удалённые): пользователь мог перевыпустить конфиг, а телефон
// остался на старом пире — его трафик всё равно нужно показать.
export function listServerDeviceKeys(
  serverId: string,
): Array<{ id: string; userId: string | null; publicKey: string | null; uuid: string | null; protocol: string }> {
  return (
    db.prepare('SELECT id, user_id, public_key, uuid, protocol FROM devices WHERE server_id = ? AND public_key IS NOT NULL').all(serverId) as any[]
  ).map((r) => ({ id: r.id, userId: r.user_id ?? null, publicKey: r.public_key ?? null, uuid: r.uuid ?? null, protocol: r.protocol }));
}
/** Активные устройства сервера с полями для повторного провижининга (после восстановления). */
export function getServerDevicesForResync(
  serverId: string,
): Array<{ name: string; protocol: string; uuid: string | null; publicKey: string | null; clientIp: string | null; presharedKeyEnc: string | null }> {
  return (
    db.prepare('SELECT name, protocol, uuid, public_key, client_ip, preshared_key_enc FROM devices WHERE server_id = ? AND is_active = 1').all(serverId) as any[]
  ).map((r) => ({ name: r.name, protocol: r.protocol, uuid: r.uuid ?? null, publicKey: r.public_key ?? null, clientIp: r.client_ip ?? null, presharedKeyEnc: r.preshared_key_enc ?? null }));
}

/** Накопленный трафик устройства и последнее сырое показание счётчиков сервера.
 *  received_bytes/sent_bytes — накопленное за всё время, rx_raw/tx_raw — что
 *  показывал сервер в прошлый замер (для вычисления прироста). */
export function getDeviceCounters(id: string): { rxTotal: number; txTotal: number; rxRaw: number; txRaw: number } {
  const r = db.prepare('SELECT received_bytes, sent_bytes, rx_raw, tx_raw FROM devices WHERE id = ?').get(id) as
    | { received_bytes: number | null; sent_bytes: number | null; rx_raw: number | null; tx_raw: number | null }
    | undefined;
  return {
    rxTotal: r?.received_bytes ?? 0,
    txTotal: r?.sent_bytes ?? 0,
    rxRaw: r?.rx_raw ?? 0,
    txRaw: r?.tx_raw ?? 0,
  };
}

/**
 * Отключить устройства, которые не выходили на связь дольше N дней.
 * ВАЖНО: last_seen_at пишется только для AmneziaWG (по handshake). У Xray
 * активность пока не отслеживается, поэтому его устройства сюда не попадают —
 * это осознанно: не отключаем то, о неактивности чего не знаем наверняка.
 * Возвращает число отключённых.
 */
export interface DisabledDevice {
  id: string;
  userId: string | null;
  name: string;
  serverId: string;
  protocol: string;
  uuid: string | null;
  publicKey: string | null;
}
/** Отключить неактивные устройства (флаг в БД) и вернуть их — чтобы вызывающий
 *  ещё и отозвал их конфиги на сервере по SSH. */
export function disableInactiveDevices(days: number): DisabledDevice[] {
  if (!days || days <= 0) return [];
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  // Только AmneziaWG: по нему у нас есть достоверная активность (handshake).
  const rows = db
    .prepare(
      "SELECT id, user_id AS userId, name, server_id AS serverId, protocol, uuid, public_key AS publicKey FROM devices WHERE is_active = 1 AND protocol = 'amneziawg' AND last_seen_at IS NOT NULL AND last_seen_at < ?",
    )
    .all(cutoff) as DisabledDevice[];
  for (const r of rows) {
    // Отзыв на сервере делает вызывающий (sync) и подтверждает его через
    // markDeviceRevokeConfirmed(…, true). Здесь — pending=1: доступ снят, автоочистка
    // не тронет запись, пока серверный отзыв не подтверждён (иначе конфиг осиротеет).
    db.prepare('UPDATE devices SET is_active = 0, revoke_pending = 1, revoked_at = NULL WHERE id = ?').run(r.id);
    if (r.userId) addHistory(r.userId, `Устройство «${r.name}» отключено автоматически: неактивно более ${days} дн`);
  }
  if (rows.length) addLog(`Автоотключение неактивных устройств: ${rows.length}`);
  return rows;
}

/** Пересчёт расхода трафика и последней активности пользователя из ВСЕХ его
 *  устройств ПЛЮС трафик уже удалённых конфигов (retired_traffic_gb): иначе
 *  удаление/очистка конфига уменьшало бы расход и возвращало квоту. */
export function recomputeUserUsage(userId: string): void {
  const row = db
    .prepare('SELECT COALESCE(SUM(traffic_gb),0) AS tg, MAX(last_seen_at) AS ls FROM devices WHERE user_id = ?')
    .get(userId) as { tg: number; ls: string | null };
  const retired = (db.prepare('SELECT retired_traffic_gb AS r FROM users WHERE id = ?').get(userId) as { r: number } | undefined)?.r ?? 0;
  // Трафик прокси-аккаунтов тоже входит в квоту — иначе через прокси (аварийный
  // доступ) можно было бы качать без учёта, обойдя лимит по гигабайтам.
  const px = db
    .prepare('SELECT COALESCE(SUM(received_bytes + sent_bytes),0) AS b, MAX(last_seen_at) AS ls FROM proxy_accounts WHERE user_id = ?')
    .get(userId) as { b: number; ls: string | null };
  const lastSeen = [row.ls, px.ls].filter(Boolean).sort().pop() ?? null; // самый свежий из устройств/прокси
  db.prepare('UPDATE users SET traffic_used_gb = @tg, last_activity_at = COALESCE(@ls, last_activity_at) WHERE id = @id').run({
    tg: (row.tg ?? 0) + retired + (px.b ?? 0) / 1e9,
    ls: lastSeen,
    id: userId,
  });
}
export function insertDevice(d: {
  userId: string | null; name: string; serverId: string; protocol: string;
  uuid?: string | null; publicKey?: string | null; privateKeyEnc?: string | null; presharedKeyEnc?: string | null;
  clientIp?: string | null; link?: string | null; conf?: string | null; source?: string; managementLevel?: string;
}): Device {
  const id = newId('d');
  db.prepare(
    `INSERT INTO devices(id,user_id,name,server_id,protocol,is_active,created_at,uuid,public_key,private_key_enc,
      preshared_key_enc,client_ip,link,conf,source,management_level,monitoring_available)
     VALUES(@id,@user_id,@name,@server_id,@protocol,1,@created_at,@uuid,@public_key,@private_key_enc,
      @preshared_key_enc,@client_ip,@link,@conf,@source,@management_level,1)`,
  ).run({
    id, user_id: d.userId, name: d.name, server_id: d.serverId, protocol: d.protocol, created_at: nowIso(),
    uuid: d.uuid ?? null, public_key: d.publicKey ?? null, private_key_enc: d.privateKeyEnc ?? null,
    preshared_key_enc: d.presharedKeyEnc ?? null, client_ip: d.clientIp ?? null, link: d.link ?? null,
    conf: encConf(d.conf), source: d.source ?? 'managed', management_level: d.managementLevel ?? 'managed',
  });
  return getDevice(id)!;
}
export function updateDeviceFields(id: string, fields: Record<string, unknown>): Device | null {
  const cols = Object.keys(fields);
  if (cols.length) {
    const set = cols.map((c) => `${c} = @${c}`).join(', ');
    db.prepare(`UPDATE devices SET ${set} WHERE id = @id`).run({ ...fields, id });
  }
  return getDevice(id);
}
/** Одноразово шифрует существующие открытые .conf (AmneziaWG) в БД. Идемпотентно:
 *  уже зашифрованные (префикс v1.) пропускаются. Вызывается при старте. */
export function migrateEncryptConfs(): number {
  const rows = db
    .prepare("SELECT id, conf FROM devices WHERE conf IS NOT NULL AND conf <> '' AND conf NOT LIKE 'v1.%'")
    .all() as Array<{ id: string; conf: string }>;
  if (!rows.length) return 0;
  const upd = db.prepare('UPDATE devices SET conf = ? WHERE id = ?');
  const tx = db.transaction(() => {
    for (const r of rows) upd.run(encConf(r.conf), r.id);
  });
  tx();
  return rows.length;
}

export function deleteDevice(id: string): void {
  // Перед удалением «списываем» трафик устройства на пользователя, иначе расход
  // (сумма по устройствам) уменьшился бы и вернул часть квоты. Затем пересчитываем.
  const d = db.prepare('SELECT user_id, traffic_gb FROM devices WHERE id = ?').get(id) as
    | { user_id: string | null; traffic_gb: number | null }
    | undefined;
  const tx = db.transaction(() => {
    if (d?.user_id && d.traffic_gb) {
      db.prepare('UPDATE users SET retired_traffic_gb = retired_traffic_gb + ? WHERE id = ?').run(d.traffic_gb, d.user_id);
    }
    db.prepare('DELETE FROM devices WHERE id = ?').run(id);
  });
  tx();
  if (d?.user_id) recomputeUserUsage(d.user_id);
}

/** Переименовать устройство (пользователь/админ). Пустое имя не допускаем. */
export function renameDevice(id: string, name: string): Device | null {
  const n = name.trim().slice(0, 60);
  if (!n) return getDevice(id);
  db.prepare('UPDATE devices SET name = ? WHERE id = ?').run(n, id);
  return getDevice(id);
}

/** Автоочистка ОТДЕЛЬНО отозванных записей старше graceDays: конфиг уже мёртв
 *  на сервере (индивидуально отозван/истёк по неактивности), запись только
 *  засоряет список и включить её нельзя. Приостановка пользователя (setUserActive)
 *  revoked_at НЕ ставит — её конфиги сюда не попадают и переживают паузу.
 *  Через deleteDevice: трафик списывается, расход не «возвращается». Число удалённых. */
export function cleanupRevokedDevices(graceDays = 3): number {
  const cutoff = new Date(Date.now() - graceDays * 86400000).toISOString();
  // revoke_pending = 0: удаляем ТОЛЬКО с подтверждённым серверным отзывом — иначе
  // живой (не отозванный) конфиг осиротел бы на сервере без возможности отзыва.
  const ids = db
    .prepare('SELECT id FROM devices WHERE is_active = 0 AND revoke_pending = 0 AND revoked_at IS NOT NULL AND revoked_at < ?')
    .all(cutoff) as Array<{ id: string }>;
  for (const r of ids) deleteDevice(r.id);
  return ids.length;
}

// ── servers ──
export function listServers(): Server[] {
  // «Пользователи» считаем реально: сколько живых пользователей имеют активный
  // конфиг на этом сервере (раньше колонка users никем не заполнялась → всегда 0).
  const counts = db
    .prepare(
      `SELECT d.server_id AS sid, COUNT(DISTINCT d.user_id) AS n
         FROM devices d JOIN users u ON u.id = d.user_id AND u.deleted_at IS NULL
        WHERE d.is_active = 1 GROUP BY d.server_id`,
    )
    .all() as Array<{ sid: string; n: number }>;
  const byServer = new Map(counts.map((c) => [c.sid, c.n]));
  return (db.prepare('SELECT * FROM servers ORDER BY created_at ASC').all() as any[]).map((r) => ({
    ...rowToServer(r),
    users: byServer.get(r.id) ?? 0,
  }));
}
export function getServer(id: string): Server | null {
  const r = db.prepare('SELECT * FROM servers WHERE id = ?').get(id) as any;
  return r ? rowToServer(r) : null;
}
export function insertServer(s: {
  name: string; country: string | null; host: string; protocols: string[]; agent?: string; endpointOk?: boolean;
  sshHost?: string; sshPort?: number; sshUser?: string; sshPassEnc?: string | null; enrollSecretEnc?: string | null;
}): Server {
  const id = newId('s');
  db.prepare(
    `INSERT INTO servers(id,name,country,host,agent,endpoint_ok,service_health,protocols,is_default,auto_issue,
      last_sync_at,recommended,ssh_host,ssh_port,ssh_user,ssh_pass_enc,enroll_secret_enc,created_at)
     VALUES(@id,@name,@country,@host,@agent,@endpoint_ok,'unknown',@protocols,0,1,@now,0,@ssh_host,@ssh_port,@ssh_user,@sshpass,@enroll,@now)`,
  ).run({
    id, name: s.name, country: s.country, host: s.host, agent: s.agent ?? 'never',
    endpoint_ok: s.endpointOk ? 1 : 0, protocols: JSON.stringify(s.protocols), now: nowIso(),
    ssh_host: s.sshHost ?? null, ssh_port: s.sshPort ?? null, ssh_user: s.sshUser ?? null,
    sshpass: s.sshPassEnc ?? null, enroll: s.enrollSecretEnc ?? null,
  });
  return getServer(id)!;
}

/** SSH-доступ к серверу (расшифрованный) — для выпуска конфигов из панели. */
export function getServerSsh(id: string): { host: string; port: number; user: string; passwordEnc: string | null } | null {
  const r = db.prepare('SELECT host, ssh_host, ssh_port, ssh_user, ssh_pass_enc FROM servers WHERE id = ?').get(id) as any;
  if (!r) return null;
  return { host: r.ssh_host || r.host, port: r.ssh_port || 22, user: r.ssh_user || 'root', passwordEnc: r.ssh_pass_enc ?? null };
}
export function setServerDefault(id: string): Server[] {
  const tx = db.transaction(() => {
    db.prepare('UPDATE servers SET is_default = 0').run();
    db.prepare('UPDATE servers SET is_default = 1 WHERE id = ?').run(id);
  });
  tx();
  return listServers();
}
export function deleteServer(id: string): void {
  // Удаление сервера удаляет привязанные к нему устройства (подписки). Трафик удаляемых
  // устройств «списываем» в retired_traffic_gb пользователей — иначе расход (сумма по
  // устройствам) уменьшился бы и вернул часть квоты (обход лимита удалением сервера).
  const rows = db.prepare('SELECT user_id, traffic_gb FROM devices WHERE server_id = ? AND user_id IS NOT NULL AND traffic_gb > 0').all(id) as Array<{ user_id: string; traffic_gb: number }>;
  const affected = new Set<string>();
  const tx = db.transaction(() => {
    for (const r of rows) {
      db.prepare('UPDATE users SET retired_traffic_gb = retired_traffic_gb + ? WHERE id = ?').run(r.traffic_gb, r.user_id);
      affected.add(r.user_id);
    }
    db.prepare('DELETE FROM devices WHERE server_id = ?').run(id);
    db.prepare('DELETE FROM servers WHERE id = ?').run(id);
  });
  tx();
  for (const uid of affected) recomputeUserUsage(uid);
}
export function updateServerFields(id: string, fields: Record<string, unknown>): Server | null {
  const cols = Object.keys(fields);
  if (cols.length) {
    const set = cols.map((c) => `${c} = @${c}`).join(', ');
    db.prepare(`UPDATE servers SET ${set} WHERE id = @id`).run({ ...fields, id });
  }
  return getServer(id);
}

// ── agent enrollment / heartbeat ──
export function setServerEnrollSecret(id: string, enc: string): void {
  db.prepare('UPDATE servers SET enroll_secret_enc = ? WHERE id = ?').run(enc, id);
}
/** Найти сервер по одноразовому enrollment-токену и закрепить за ним агента. */
export function enrollAgent(
  matches: (enc: string) => boolean,
  publicKeyPem: string,
  version: string,
): { serverId: string } | null {
  const rows = db
    .prepare("SELECT id, enroll_secret_enc FROM servers WHERE enroll_secret_enc IS NOT NULL AND agent_public_key IS NULL")
    .all() as Array<{ id: string; enroll_secret_enc: string }>;
  for (const r of rows) {
    if (matches(r.enroll_secret_enc)) {
      db.prepare(
        "UPDATE servers SET agent_public_key = ?, agent = 'online', agent_version = ?, last_sync_at = ?, enroll_secret_enc = NULL WHERE id = ?",
      ).run(publicKeyPem, version, nowIso(), r.id);
      return { serverId: r.id };
    }
  }
  return null;
}
export function getServerAgentKey(serverId: string): string | null {
  const r = db.prepare('SELECT agent_public_key FROM servers WHERE id = ?').get(serverId) as any;
  return r?.agent_public_key ?? null;
}
export function agentHeartbeat(serverId: string, healthy: boolean, version: string): void {
  db.prepare("UPDATE servers SET agent = 'online', last_sync_at = ?, agent_version = ?, service_health = ? WHERE id = ?").run(
    nowIso(),
    version,
    healthy ? 'healthy' : 'degraded',
    serverId,
  );
}
/** Обновить трафик/handshake устройства по uuid или public_key. */
export function applyTrafficSample(serverId: string, key: string, received: number | null, sent: number | null, lastAt: string | null): void {
  const total = (received ?? 0) + (sent ?? 0);
  db.prepare(
    `UPDATE devices SET received_bytes = COALESCE(?, received_bytes), sent_bytes = COALESCE(?, sent_bytes),
       traffic_gb = ?, last_seen_at = COALESCE(?, last_seen_at)
     WHERE server_id = ? AND (uuid = ? OR public_key = ?)`,
  ).run(received, sent, total / 1e9, lastAt, serverId, key, key);
}

// ── apps ──
export function listApps(): AppClient[] {
  return (db.prepare('SELECT id, data FROM app_clients ORDER BY sort ASC').all() as any[]).map(rowToApp);
}
export function replaceApps(apps: AppClient[]): AppClient[] {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM app_clients').run();
    const stmt = db.prepare('INSERT INTO app_clients(id, sort, data) VALUES(?,?,?)');
    apps.forEach((a, i) => stmt.run(a.id, i, JSON.stringify(a)));
  });
  tx();
  return listApps();
}
export function getApp(id: string): AppClient | null {
  const r = db.prepare('SELECT id, data FROM app_clients WHERE id = ?').get(id) as any;
  return r ? rowToApp(r) : null;
}
/** Привязать/снять файл на диске к платформе приложения (после стрим-загрузки). */
export function setAppDownload(appId: string, platform: string, name: string | null, size: number | null): AppClient | null {
  const app = getApp(appId);
  if (!app) return null;
  const entry = app.platforms.find((p) => p.platform === platform);
  if (!entry) return null;
  entry.downloadName = name;
  entry.downloadSize = size;
  db.prepare('UPDATE app_clients SET data = ? WHERE id = ?').run(JSON.stringify(app), appId);
  return app;
}
/** Все привязки файлов (appId+platform+имя) — для нахождения/чистки файлов на диске. */
export function allDownloadRefs(): Array<{ appId: string; platform: string; name: string }> {
  const out: Array<{ appId: string; platform: string; name: string }> = [];
  for (const a of listApps())
    for (const p of a.platforms) if (p.downloadName) out.push({ appId: a.id, platform: p.platform, name: p.downloadName });
  return out;
}

/** Запомнить числовой chat_id привязанного пользователя (для бот-рассылки).
 *  Пишем только при изменении, чтобы не дёргать updated_at на каждом сообщении. */
export function setTelegramChatId(userId: string, chatId: number): void {
  // Один chat_id принадлежит РОВНО одному пользователю. Раньше привязка обновляла
  // только целевую строку, не снимая chat_id с других — на один Telegram оказывались
  // навешаны две записи (напр. после удаления и пересоздания пользователя), и бот
  // «залипал» на первой попавшейся (часто удалённой) строке. Сначала снимаем chat_id
  // со всех остальных, затем ставим целевой — атомарно.
  const tx = db.transaction((uid: string, cid: number) => {
    db.prepare('UPDATE users SET telegram_chat_id = NULL WHERE telegram_chat_id = ? AND id != ?').run(cid, uid);
    db.prepare('UPDATE users SET telegram_chat_id = ? WHERE id = ?').run(cid, uid);
  });
  tx(userId, chatId);
}

/** Пользователь по НЕИЗМЕНЯЕМОМУ chat_id Telegram. Удалённые не резолвятся. */
export function getUserByTelegramChatId(chatId: number): User | null {
  const r = db
    .prepare('SELECT id FROM users WHERE telegram_chat_id = ? AND deleted_at IS NULL ORDER BY rowid LIMIT 1')
    .get(chatId) as { id: string } | undefined;
  return r ? getUser(r.id) : null;
}

/** Идентификация пользователя в боте — ТОЛЬКО по неизменяемому chat_id.
 *  @username в Telegram переиспользуемы: идентификация по handle позволяла новому
 *  владельцу чужого username захватить аккаунт (устройства, выпуск конфигов). Handle
 *  храним лишь для отображения; для привязки нужен явный токен личной ссылки/код,
 *  после чего chat_id зафиксирован. */
export function findBotUser(chatId: number, _handle?: string): User | null {
  return getUserByTelegramChatId(chatId);
}

/** Привязанные к Telegram пользователи — цели экстренной рассылки. Только активные,
 *  не удалённые, каждый chat_id один раз (иначе дубль сообщений и двойной расход лимита). */
export function listTelegramTargets(): Array<{ id: string; name: string; chatId: number }> {
  return (
    db
      .prepare(
        `SELECT MIN(id) AS id, MIN(name) AS name, telegram_chat_id AS chatId
           FROM users
          WHERE telegram_chat_id IS NOT NULL AND deleted_at IS NULL AND is_active = 1
          GROUP BY telegram_chat_id`,
      )
      .all() as Array<{ id: string; name: string; chatId: number }>
  ).map((r) => ({ id: r.id, name: r.name, chatId: r.chatId }));
}

// ── settings / telegram ──
export function getSettings(): AppSettings {
  return getSetting<AppSettings>('settings', {} as AppSettings);
}
export function saveSettings(s: AppSettings): AppSettings {
  setSetting('settings', s);
  return s;
}
export function getTelegram(): TelegramSettings {
  return getSetting<TelegramSettings>('telegram', {} as TelegramSettings);
}
/** Безопасная версия — без зашифрованных секретов (для bootstrap/ответов наружу). */
export function getTelegramSafe(): TelegramSettings {
  const { tokenEnc: _t, proxyPassEnc: _p, ...safe } = getTelegram() as TelegramSettings & {
    tokenEnc?: string;
    proxyPassEnc?: string;
  };
  // linkedUserIds раньше не заполнялся (всегда []), из-за чего раздел «Привязанные
  // пользователи» в панели был всегда пуст. Формируем из пользователей с привязкой.
  const linkedUserIds = (
    db.prepare('SELECT id FROM users WHERE telegram IS NOT NULL AND deleted_at IS NULL').all() as Array<{ id: string }>
  ).map((r) => r.id);
  return { ...safe, linkedUserIds };
}
/** Зашифрованный токен сохранённого бота (для проверки соединения к текущему). */
export function getTelegramTokenEnc(): string | null {
  return (getTelegram() as { tokenEnc?: string }).tokenEnc ?? null;
}
export function saveTelegramRaw(t: TelegramSettings): TelegramSettings {
  setSetting('telegram', t);
  return t;
}

// ── logs / history ──
export function addLog(text: string): void {
  db.prepare('INSERT INTO admin_log(at, text) VALUES(?, ?)').run(nowIso(), text);
}
export function listLog(limit = 30): LogEntry[] {
  return db.prepare('SELECT at, text FROM admin_log ORDER BY id DESC LIMIT ?').all(limit) as LogEntry[];
}
export function listJobErrors(limit = 20): JobError[] {
  return db.prepare('SELECT at, server, text FROM job_errors ORDER BY id DESC LIMIT ?').all(limit) as JobError[];
}
/** Записать реальную ошибку фоновой операции (установка/синхронизация) — видна на «Обзоре». */
export function addJobError(server: string, text: string): void {
  db.prepare('INSERT INTO job_errors(at, server, text) VALUES(?,?,?)').run(nowIso(), server, text.slice(0, 300));
  // держим только последние 50
  db.prepare('DELETE FROM job_errors WHERE id NOT IN (SELECT id FROM job_errors ORDER BY id DESC LIMIT 50)').run();
}
export function addHistory(userId: string, text: string): void {
  db.prepare('INSERT INTO user_history(user_id, at, text) VALUES(?, ?, ?)').run(userId, nowIso(), text);
}
export function historyFor(userId: string): LogEntry[] {
  return db.prepare('SELECT at, text FROM user_history WHERE user_id = ? ORDER BY id DESC').all(userId) as LogEntry[];
}
export function allHistory(): Record<string, LogEntry[]> {
  const rows = db.prepare('SELECT user_id, at, text FROM user_history ORDER BY id DESC').all() as Array<{ user_id: string; at: string; text: string }>;
  const out: Record<string, LogEntry[]> = {};
  for (const r of rows) (out[r.user_id] ??= []).push({ at: r.at, text: r.text });
  return out;
}

// ── bootstrap ──
/** Урезанное представление пользователя для публичной части. */
export function toPublicUserView(u: User): PublicUserView {
  return {
    id: u.id, name: u.name, code: u.code, deviceLimit: u.deviceLimit, expiresAt: u.expiresAt,
    trafficLimitGb: u.trafficLimitGb, trafficUsedGb: u.trafficUsedGb, allowedServers: u.allowedServers,
    defaultServerId: u.defaultServerId, allowedProtocols: u.allowedProtocols, isActive: u.isActive,
    telegramLinked: !!u.telegram, codeLoginUntil: u.codeLoginUntil,
  };
}

/** Полные данные для панели админа. Содержат коды доступа и конфиги ВСЕХ —
 *  отдавать только по requireAdmin. */
export function buildBootstrap(): BootstrapData {
  return {
    users: listUsers(),
    devices: listDevices(),
    servers: listServers(),
    apps: listApps(),
    telegram: getTelegramSafe(),
    settings: getSettings(),
    adminLog: listLog(),
    jobErrors: listJobErrors(),
    history: allHistory(),
    dbHealth: checkDbIsolation(earliestDataIso()),
    mustChangePassword: isDefaultAdminPassword(),
  };
}

/** Время самой ранней записи в базе (для самотеста персистентности): если данные
 *  старше текущего процесса — том очевидно постоянный. */
function earliestDataIso(): string | null {
  const r = db
    .prepare('SELECT MIN(t) AS t FROM (SELECT created_at AS t FROM users UNION ALL SELECT at AS t FROM admin_log)')
    .get() as { t: string | null } | undefined;
  return r?.t ?? null;
}

/** Устройства одного пользователя (с конфигами — это его собственные).
 *  Для AmneziaWG добавляем ссылку vpn:// — она собирается из самого .conf. */
export function listDevicesOfUser(userId: string): Device[] {
  return (db.prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY created_at DESC').all(userId) as any[])
    .map(rowToDevice)
    .map((d) => (d.protocol === 'amneziawg' && d.conf ? { ...d, vpnKey: vpnLinkFromConf(d.conf, d.name) } : d));
}

/** Ссылки для Xray-подписки: ОДИН активный конфиг на каждый сервер. У части
 *  пользователей до внедрения дедупа накопились дубли (по конфигу на каждое
 *  устройство одного сервера) — подписка отдавала их все, приложение показывало
 *  «кучу разных девайсов» и могло цепляться за устаревший. Оставляем по одному
 *  самому свежему на сервер (список отсортирован created_at DESC). */
export function subscriptionXrayLinks(userId: string): string[] {
  const seen = new Set<string>();
  const links: string[] = [];
  for (const d of listDevicesOfUser(userId)) {
    if (!d.isActive || d.protocol !== 'xray' || !d.link) continue;
    if (seen.has(d.serverId)) continue;
    seen.add(d.serverId);
    links.push(d.link);
  }
  return links;
}

/** Данные публичной части. Без userId — только справочники (серверы, приложения):
 *  ни кодов, ни конфигов, ни чужих устройств. */
/** Публичный адрес подписки Xray для пользователя. */
/** Публичный базовый адрес панели СО СХЕМОЙ. Домен из настроек человек часто
 *  вводит без https:// («panel.example.ru») — нормализуем, иначе ссылки-подписки
 *  и адреса в /sub получаются битыми (VPN-приложению нужен полный URL). */
export function publicBaseUrl(fallbackOrigin?: string): string {
  const domain = (getSettings()?.domain || '').trim().replace(/\/+$/, '');
  if (domain) return /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
  // Домен не задан: предпочитаем адрес, по которому пользователь реально обратился
  // (request origin), и только в последнюю очередь PUBLIC_URL из окружения (в деве
  // это localhost) — иначе выданные ссылки молча вели бы на localhost.
  const fo = (fallbackOrigin || '').trim().replace(/\/+$/, '');
  if (fo) return /^https?:\/\//i.test(fo) ? fo : `https://${fo}`;
  const envUrl = (config.publicUrl || '').trim().replace(/\/+$/, '');
  return envUrl ? (/^https?:\/\//i.test(envUrl) ? envUrl : `https://${envUrl}`) : '';
}

export function subscriptionUrl(userId: string, fallbackOrigin?: string): string | null {
  const t = getSubToken(userId);
  if (!t) return null;
  const base = publicBaseUrl(fallbackOrigin);
  return base ? `${base}/sub/${t}` : null;
}

export function buildPublicBootstrap(userId?: string, fallbackOrigin?: string): PublicBootstrapData {
  const tg = getTelegramSafe();
  const user = userId ? getUser(userId) : null;
  // Deep-link привязки: /start <токен пользователя>. Токен длинный, не подбирается.
  const token = user ? getAccessToken(user.id) : null;
  const botLink =
    tg.enabled && tg.botUsername && token ? `https://t.me/${tg.botUsername}?start=${token}` : null;
  return {
    user: user && user.isActive ? toPublicUserView(user) : null,
    devices: user ? listDevicesOfUser(user.id) : [],
    servers: listServers().map((s) => ({
      id: s.id,
      name: s.name,
      country: s.country,
      host: s.host,
      protocols: s.protocols,
      isDefault: s.isDefault,
      recommended: s.recommended,
      online: s.agent === 'online' && s.endpointOk,
    })),
    apps: listApps(),
    telegram: { enabled: tg.enabled, botUsername: tg.botUsername ?? null },
    botLink,
    subLink: user ? subscriptionUrl(user.id, fallbackOrigin) : null,
    proxyAccounts: user ? listProxyAccountsOfUser(user.id) : [],
    allowedProxies: user ? user.allowedProxies : [],
    // Отсутствие поля = ВКЛ (старые панели): продвинутый режим по умолчанию включён.
    xrayWhitelist: getSettings().xrayWhitelist !== false,
  };
}
