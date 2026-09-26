// Хранилище резервной маршрутизации: внешние подписки, разобранные из них
// серверы и наш внутренний учёт резервного расхода. Вынесено из repo.ts, чтобы
// не раздувать его; опирается на общий db и хелперы newId/nowIso/getUser.
import type { BackupServer, BackupSubscription, ReserveLimits } from '@novpn/shared';
import { RESERVE_DEFAULTS } from '@novpn/shared';
import { db } from './db.js';
import { getSettings, getUser, newId, nowIso } from './repo.js';

function rowToBackupSub(r: any): BackupSubscription {
  const serverCount = (
    db.prepare('SELECT COUNT(*) AS n FROM backup_servers WHERE subscription_id = ?').get(r.id) as { n: number }
  ).n;
  const internalBytes = (
    db.prepare('SELECT COALESCE(SUM(bytes),0) AS b FROM backup_traffic WHERE subscription_id = ?').get(r.id) as { b: number }
  ).b;
  return {
    id: r.id,
    ownerUserId: r.owner_user_id ?? null,
    title: r.title ?? '',
    url: r.url,
    userAgent: r.user_agent ?? null,
    hwid: r.hwid ?? null,
    enabled: !!r.enabled,
    kind: r.kind === 'outage' ? 'outage' : 'whitelist',
    sort: r.sort ?? 0,
    availableFor: r.available_for === 'priority' ? 'priority' : 'all',
    limitGb: r.limit_gb ?? null,
    provider: {
      upload: r.sub_upload ?? null,
      download: r.sub_download ?? null,
      total: r.sub_total ?? null,
      expire: r.sub_expire ?? null,
    },
    format: r.format ?? null,
    serverCount,
    lastFetchedAt: r.last_fetched_at ?? null,
    lastError: r.last_error ?? null,
    internalBytes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** ownerUserId: undefined — все; null — только общий пул админа; строка — подписки пользователя. */
export function listBackupSubscriptions(ownerUserId?: string | null): BackupSubscription[] {
  let rows: any[];
  if (ownerUserId === undefined) {
    rows = db.prepare('SELECT * FROM backup_subscriptions ORDER BY owner_user_id IS NULL DESC, created_at').all();
  } else if (ownerUserId === null) {
    rows = db.prepare('SELECT * FROM backup_subscriptions WHERE owner_user_id IS NULL ORDER BY created_at').all();
  } else {
    rows = db.prepare('SELECT * FROM backup_subscriptions WHERE owner_user_id = ? ORDER BY created_at').all(ownerUserId);
  }
  return rows.map(rowToBackupSub);
}

export function getBackupSubscription(id: string): BackupSubscription | null {
  const r = db.prepare('SELECT * FROM backup_subscriptions WHERE id = ?').get(id);
  return r ? rowToBackupSub(r) : null;
}

/** Сырая строка (owner_user_id, url, user_agent, hwid, etag…) — для фонового фетчера. */
export function getBackupSubscriptionRow(id: string): any {
  return db.prepare('SELECT * FROM backup_subscriptions WHERE id = ?').get(id) ?? null;
}

export function listBackupSubscriptionRows(): any[] {
  return db.prepare('SELECT * FROM backup_subscriptions ORDER BY created_at').all() as any[];
}

export function insertBackupSubscription(p: {
  ownerUserId?: string | null;
  title?: string;
  url: string;
  userAgent?: string | null;
  hwid?: string | null;
  enabled?: boolean;
  kind?: 'whitelist' | 'outage';
  sort?: number;
  availableFor?: 'all' | 'priority';
  limitGb?: number | null;
}): BackupSubscription {
  const id = newId('bk');
  const now = nowIso();
  db.prepare(
    `INSERT INTO backup_subscriptions(id, owner_user_id, title, url, user_agent, hwid, enabled, kind, sort, limit_gb, available_for, created_at, updated_at)
     VALUES(@id, @owner, @title, @url, @ua, @hwid, @enabled, @kind, @sort, @limit_gb, @available_for, @now, @now)`,
  ).run({
    id,
    owner: p.ownerUserId ?? null,
    title: p.title ?? '',
    url: p.url,
    ua: p.userAgent ?? null,
    hwid: p.hwid ?? null,
    enabled: p.enabled === false ? 0 : 1,
    kind: p.kind === 'outage' ? 'outage' : 'whitelist',
    sort: p.sort ?? 0,
    limit_gb: p.limitGb ?? null,
    available_for: p.availableFor === 'priority' ? 'priority' : 'all',
    now,
  });
  return getBackupSubscription(id)!;
}

export function updateBackupSubscription(id: string, fields: Record<string, unknown>): BackupSubscription | null {
  const cols = Object.keys(fields);
  if (cols.length) {
    const set = cols.map((c) => `${c} = @${c}`).join(', ');
    db.prepare(`UPDATE backup_subscriptions SET ${set}, updated_at = @updated_at WHERE id = @id`).run({
      ...fields,
      id,
      updated_at: nowIso(),
    });
  }
  return getBackupSubscription(id);
}

export function deleteBackupSubscription(id: string): void {
  db.prepare('DELETE FROM backup_subscriptions WHERE id = ?').run(id);
}

/** Записать результат фетча: статистику провайдера и заново разобранный список серверов. */
export function setBackupFetchResult(
  id: string,
  r: {
    format?: string;
    /** Пропущено (undefined) → список серверов НЕ трогаем (напр. на HTTP 304). */
    servers?: Array<{ name: string; link: string; host: string; port: number; protocol: string }>;
    provider?: { upload?: number; download?: number; total?: number; expire?: number };
    etag?: string | null;
    lastModified?: string | null;
    error?: string | null;
  },
): void {
  const now = nowIso();
  const tx = db.transaction(() => {
    const p = r.provider ?? {};
    // COALESCE(@x, col): если метаданные не переданы (undefined→null) — СОХРАНЯЕМ прежние,
    // а не затираем. На HTTP 304 provider/format не приходят, и раньше они обнулялись —
    // ровно та статистика, которую путь 304 должен беречь.
    db.prepare(
      `UPDATE backup_subscriptions SET
         format = COALESCE(@format, format),
         sub_upload = COALESCE(@up, sub_upload), sub_download = COALESCE(@down, sub_download),
         sub_total = COALESCE(@total, sub_total), sub_expire = COALESCE(@expire, sub_expire),
         etag = @etag, last_modified = @lm, last_fetched_at = @now, last_error = @error, updated_at = @now
       WHERE id = @id`,
    ).run({
      id,
      format: r.format ?? null,
      up: p.upload ?? null,
      down: p.download ?? null,
      total: p.total ?? null,
      expire: p.expire ?? null,
      etag: r.etag ?? null,
      lm: r.lastModified ?? null,
      error: r.error ?? null,
      now,
    });
    // Список серверов перезаписываем целиком ТОЛЬКО когда он реально передан и фетч
    // успешен. Если servers не передан (304 — ничего не изменилось) — не трогаем,
    // иначе затёрли бы пул. Пустой массив на ошибке отсекается проверкой !r.error.
    if (!r.error && r.servers) {
      db.prepare('DELETE FROM backup_servers WHERE subscription_id = ?').run(id);
      let sort = 0;
      const ins = db.prepare(
        `INSERT INTO backup_servers(id, subscription_id, name, link, host, port, protocol, enabled, sort, created_at)
         VALUES(@id, @sub, @name, @link, @host, @port, @proto, 1, @sort, @now)`,
      );
      for (const s of r.servers) {
        ins.run({
          id: newId('bs'),
          sub: id,
          name: s.name,
          link: s.link,
          host: s.host,
          port: s.port,
          proto: s.protocol,
          sort: sort++,
          now,
        });
      }
    }
  });
  tx();
}

export function listBackupServers(subscriptionId: string): BackupServer[] {
  return (db.prepare('SELECT * FROM backup_servers WHERE subscription_id = ? ORDER BY sort').all(subscriptionId) as any[]).map(
    (r) => ({
      id: r.id,
      subscriptionId: r.subscription_id,
      name: r.name,
      host: r.host,
      port: r.port,
      protocol: r.protocol,
      enabled: !!r.enabled,
    }),
  );
}

export interface ReserveLink {
  subscriptionId: string;
  name: string;
  link: string;
  host: string;
  port: number;
  kind: 'whitelist' | 'outage';
  /** true — личная подписка пользователя (owner=uid); false — общий пул админа. Личные
   *  доступны всегда, общий пул подчиняется настройкам уровня и лимитам. */
  personal: boolean;
}

/** ЭЛИГИБЕЛЬНЫЙ резервный пул по ВЛАДЕНИЮ и доступности: личные подписки пользователя +
 *  общие подписки админа, доступные всем ('all') или, для 'priority', только приоритетным.
 *  Опциональный `kind` сужает до одной корзины. Порядок: общие раньше личных, затем по sort.
 *  ВНИМАНИЕ: это СЫРАЯ элигибельность (без настроечного гейта корзин и без лимитов) —
 *  для выдачи используйте reservePoolForUser, который их применяет. */
export function backupServerLinksForUser(userId: string, kind?: 'whitelist' | 'outage'): ReserveLink[] {
  const user = getUser(userId);
  if (!user) return [];
  const subs = db
    .prepare(
      `SELECT id, kind, owner_user_id FROM backup_subscriptions
       WHERE enabled = 1
         AND (owner_user_id = @uid OR (owner_user_id IS NULL AND (available_for = 'all' OR @priority = 1)))
         AND (@kind IS NULL OR kind = @kind)
       ORDER BY owner_user_id IS NULL DESC, sort, created_at`,
    )
    .all({ uid: userId, priority: user.priorityAccess ? 1 : 0, kind: kind ?? null }) as Array<{ id: string; kind: string; owner_user_id: string | null }>;
  const out: ReserveLink[] = [];
  for (const s of subs) {
    const k: 'whitelist' | 'outage' = s.kind === 'outage' ? 'outage' : 'whitelist';
    const personal = s.owner_user_id != null;
    const rows = db
      .prepare("SELECT * FROM backup_servers WHERE subscription_id = ? AND enabled = 1 AND link != '' ORDER BY sort")
      .all(s.id) as any[];
    for (const r of rows) out.push({ subscriptionId: s.id, name: r.name, link: r.link, host: r.host, port: r.port, kind: k, personal });
  }
  return out;
}

/** Есть ли у пользователя хоть один ДОСТУПНЫЙ (с учётом настроек/лимитов) резервный сервер. */
export function userHasBackup(userId: string): boolean {
  return reservePoolForUser(userId).links.length > 0;
}

/** Прибавить наш внутренний резервный расход (цифры шлёт клиент). */
export function addBackupTraffic(userId: string, subscriptionId: string, bytes: number): void {
  if (!(bytes > 0)) return;
  db.prepare(
    `INSERT INTO backup_traffic(user_id, subscription_id, bytes, updated_at)
     VALUES(@u, @s, @b, @now)
     ON CONFLICT(user_id, subscription_id) DO UPDATE SET bytes = bytes + @b, updated_at = @now`,
  ).run({ u: userId, s: subscriptionId, b: Math.trunc(bytes), now: nowIso() });
}

/** Отнести резервный расход на подписку, которой принадлежит сервер host (в пуле пользователя).
 *  Клиент знает только host сервера — не внутренние id подписок; сопоставляем здесь. */
export function attributeBackupTraffic(userId: string, host: string, bytes: number): boolean {
  if (!host || !(bytes > 0)) return false;
  const user = getUser(userId);
  if (!user) return false;
  const row = db
    .prepare(
      `SELECT s.id AS sub_id, s.kind AS kind
       FROM backup_subscriptions s JOIN backup_servers bs ON bs.subscription_id = s.id
       WHERE s.enabled = 1 AND bs.host = @host
         AND (s.owner_user_id = @uid OR (s.owner_user_id IS NULL AND (s.available_for = 'all' OR @priority = 1)))
       ORDER BY s.owner_user_id IS NULL DESC, s.sort, s.created_at
       LIMIT 1`,
    )
    .get({ host, uid: userId, priority: user.priorityAccess ? 1 : 0 }) as { sub_id: string; kind?: string } | undefined;
  if (!row) return false;
  addBackupTraffic(userId, row.sub_id, bytes);
  // Помесячный учёт по КОРЗИНЕ — для мягких лимитов (см. reservePoolForUser).
  addMonthlyUsage(userId, row.kind === 'outage' ? 'outage' : 'whitelist', bytes);
  return true;
}

// ── помесячный учёт и мягкие лимиты по корзинам ──

function monthKey(iso: string): string {
  // YYYY-MM. nowIso() в UTC → сброс лимитов происходит в UTC-полночь 1-го числа (не в
  // локальную). Для мягкого месячного лимита это приемлемо; если понадобится локальный
  // месяц — сдвигать на TZ-оффсет до слайса.
  return iso.slice(0, 7);
}

/** Прибавить помесячный резервный расход по корзине (для лимитов). */
export function addMonthlyUsage(userId: string, kind: 'whitelist' | 'outage', bytes: number): void {
  if (!(bytes > 0)) return;
  db.prepare(
    `INSERT INTO backup_usage_monthly(user_id, kind, month, bytes) VALUES(@u,@k,@m,@b)
     ON CONFLICT(user_id, kind, month) DO UPDATE SET bytes = bytes + @b`,
  ).run({ u: userId, k: kind, m: monthKey(nowIso()), b: Math.trunc(bytes) });
}

/** Расход по корзине за ТЕКУЩИЙ календарный месяц, ГБ. */
export function monthlyUsageGb(userId: string, kind: 'whitelist' | 'outage'): number {
  const r = db
    .prepare('SELECT bytes FROM backup_usage_monthly WHERE user_id=? AND kind=? AND month=?')
    .get(userId, kind, monthKey(nowIso())) as { bytes: number } | undefined;
  return (r?.bytes ?? 0) / 1e9;
}

export type BucketState = 'ok' | 'off' | 'exhausted';
export interface ReservePool {
  links: ReserveLink[];
  whitelist: BucketState;
  outage: BucketState;
}

function resolveReserveLimits(): ReserveLimits {
  return { ...RESERVE_DEFAULTS, ...(getSettings().reserve ?? {}) };
}

/** Итоговый резервный пул для пользователя С УЧЁТОМ настроек (доступность корзины по
 *  уровню доступа) и МЯГКИХ месячных лимитов. Приоритетным доступны обе корзины (лимиты
 *  из настроек, по умолчанию безлимит); обычным — по тумблерам и лимитам. Состояние
 *  корзины: 'ok' — выдаём; 'off' — не положена уровню; 'exhausted' — лимит исчерпан
 *  (клиент покажет «лимит исчерпан», обычный VPN продолжает работать). */
export function reservePoolForUser(userId: string, kind?: 'whitelist' | 'outage'): ReservePool {
  const user = getUser(userId);
  if (!user) return { links: [], whitelist: 'off', outage: 'off' };
  const lim = resolveReserveLimits();
  const priority = !!user.priorityAccess;
  const stateOf = (k: 'whitelist' | 'outage'): BucketState => {
    if (!priority) {
      if (k === 'whitelist' && !lim.whitelistForRegular) return 'off';
      if (k === 'outage' && !lim.outageForRegular) return 'off';
    }
    const capGb = priority
      ? k === 'whitelist'
        ? lim.whitelistPriorityGb
        : lim.outagePriorityGb
      : k === 'whitelist'
        ? lim.whitelistRegularGb
        : lim.outageRegularGb;
    if (capGb != null && monthlyUsageGb(userId, k) >= capGb) return 'exhausted';
    return 'ok';
  };
  const whitelist = stateOf('whitelist');
  const outage = stateOf('outage');
  const links: ReserveLink[] = [];
  for (const k of kind ? [kind] : (['whitelist', 'outage'] as const)) {
    const sharedOk = (k === 'whitelist' ? whitelist : outage) === 'ok';
    for (const l of backupServerLinksForUser(userId, k)) {
      // Личные подписки пользователя доступны ВСЕГДА (он сам их добавил) — их не режут
      // тумблеры уровня и лимиты общего пула. Общий пул — только когда корзина 'ok'.
      if (l.personal || sharedOk) links.push(l);
    }
  }
  return { links, whitelist, outage };
}

// ── журнал диагностики от клиента (§13) ──

export interface DiagEntry {
  at: string;
  kind: string;
  text: string;
}

/** Принять пачку записей диагностики от клиента и обрезать хвост до лимита. */
export function addClientDiag(userId: string, entries: DiagEntry[]): number {
  if (!entries.length) return 0;
  const now = nowIso();
  const ins = db.prepare('INSERT INTO client_diag(user_id, at, kind, text, received_at) VALUES(?,?,?,?,?)');
  const tx = db.transaction(() => {
    for (const e of entries.slice(0, 100)) {
      ins.run(userId, String(e.at || now).slice(0, 40), String(e.kind || '').slice(0, 24), String(e.text || '').slice(0, 500), now);
    }
    // Оставляем последние 200 записей на пользователя.
    db.prepare(
      `DELETE FROM client_diag WHERE user_id = @u AND id NOT IN (
         SELECT id FROM client_diag WHERE user_id = @u ORDER BY id DESC LIMIT 200)`,
    ).run({ u: userId });
  });
  tx();
  return Math.min(entries.length, 100);
}

/** Последние записи диагностики пользователя (новые первыми). */
export function listClientDiag(userId: string, limit = 100): Array<DiagEntry & { receivedAt: string }> {
  const rows = db
    .prepare('SELECT at, kind, text, received_at FROM client_diag WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(userId, Math.min(limit, 200)) as any[];
  return rows.map((r) => ({ at: r.at, kind: r.kind, text: r.text, receivedAt: r.received_at }));
}

/** Разбивка внутреннего резервного расхода по пользователям для одной подписки. */
export function backupTrafficBySub(subscriptionId: string): Array<{ userId: string; name: string; bytes: number }> {
  const rows = db
    .prepare(
      `SELECT t.user_id AS user_id, COALESCE(u.name,'—') AS name, t.bytes AS bytes
       FROM backup_traffic t LEFT JOIN users u ON u.id = t.user_id
       WHERE t.subscription_id = ? ORDER BY t.bytes DESC`,
    )
    .all(subscriptionId) as any[];
  return rows.map((r) => ({ userId: r.user_id, name: r.name, bytes: r.bytes }));
}
