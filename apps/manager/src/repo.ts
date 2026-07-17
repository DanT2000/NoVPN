// Слой доступа к данным + сборка bootstrap. Единственное место SQL-запросов.

import crypto from 'node:crypto';
import type {
  AppClient,
  AppSettings,
  BootstrapData,
  Device,
  JobError,
  LogEntry,
  PublicBootstrapData,
  PublicUserView,
  Server,
  TelegramSettings,
  User,
} from '@novpn/shared';
import { db, getSetting, setSetting } from './db.js';
import { rowToApp, rowToDevice, rowToServer, rowToUser } from './mappers.js';

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
}

export function insertUser(u: NewUserRow): User {
  const id = newId('u');
  const now = nowIso();
  db.prepare(
    `INSERT INTO users(id,name,comment,category,tags,code,device_limit,expires_at,traffic_limit_gb,traffic_used_gb,
      reset_policy,allowed_servers,default_server_id,allowed_protocols,is_active,telegram,created_at,updated_at,
      access_token,code_login_until)
     VALUES(@id,@name,@comment,@category,@tags,@code,@device_limit,@expires_at,@traffic_limit_gb,0,
      @reset_policy,@allowed_servers,@default_server_id,@allowed_protocols,1,NULL,@now,@now,
      @access_token,NULL)`,
  ).run({
    id, name: u.name, comment: u.comment, category: u.category, tags: JSON.stringify(u.tags), code: u.code,
    device_limit: u.deviceLimit, expires_at: u.expiresAt, traffic_limit_gb: u.trafficLimitGb,
    reset_policy: u.resetPolicy, allowed_servers: JSON.stringify(u.allowedServers),
    default_server_id: u.defaultServerId, allowed_protocols: JSON.stringify(u.allowedProtocols), now,
    // Личная ссылка выдаётся сразу. code_login_until = NULL: новым вход по коду
    // не положен, у них есть ссылка.
    access_token: crypto.randomBytes(18).toString('base64url'),
  });
  return getUser(id)!;
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
  db.prepare('UPDATE devices SET is_active = 0, revoked_at = ? WHERE user_id = ?').run(nowIso(), id);
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
export function getDeviceRow(id: string): { uuid: string | null; public_key: string | null; protocol: string; server_id: string } | null {
  return (db.prepare('SELECT uuid, public_key, protocol, server_id FROM devices WHERE id = ?').get(id) as any) ?? null;
}
export function countActiveDevices(userId: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM devices WHERE user_id = ? AND is_active = 1').get(userId) as { n: number }).n;
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

/** Пересчёт расхода трафика и последней активности пользователя из ВСЕХ его устройств. */
export function recomputeUserUsage(userId: string): void {
  const row = db
    .prepare('SELECT COALESCE(SUM(traffic_gb),0) AS tg, MAX(last_seen_at) AS ls FROM devices WHERE user_id = ?')
    .get(userId) as { tg: number; ls: string | null };
  db.prepare('UPDATE users SET traffic_used_gb = @tg, last_activity_at = COALESCE(@ls, last_activity_at) WHERE id = @id').run({
    tg: row.tg ?? 0,
    ls: row.ls ?? null,
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
    conf: d.conf ?? null, source: d.source ?? 'managed', management_level: d.managementLevel ?? 'managed',
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
export function deleteDevice(id: string): void {
  db.prepare('DELETE FROM devices WHERE id = ?').run(id);
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
  // Удаление сервера удаляет привязанные к нему устройства (подписки).
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM devices WHERE server_id = ?').run(id);
    db.prepare('DELETE FROM servers WHERE id = ?').run(id);
  });
  tx();
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
  return safe;
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
  };
}

/** Устройства одного пользователя (с конфигами — это его собственные). */
export function listDevicesOfUser(userId: string): Device[] {
  return (db.prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY created_at DESC').all(userId) as any[]).map(rowToDevice);
}

/** Данные публичной части. Без userId — только справочники (серверы, приложения):
 *  ни кодов, ни конфигов, ни чужих устройств. */
export function buildPublicBootstrap(userId?: string): PublicBootstrapData {
  const tg = getTelegramSafe();
  const user = userId ? getUser(userId) : null;
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
  };
}
