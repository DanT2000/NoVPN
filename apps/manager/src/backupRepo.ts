// Хранилище резервной маршрутизации: внешние подписки, разобранные из них
// серверы и наш внутренний учёт резервного расхода. Вынесено из repo.ts, чтобы
// не раздувать его; опирается на общий db и хелперы newId/nowIso/getUser.
import type { BackupServer, BackupSubscription } from '@novpn/shared';
import { db } from './db.js';
import { getUser, newId, nowIso } from './repo.js';

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
}): BackupSubscription {
  const id = newId('bk');
  const now = nowIso();
  db.prepare(
    `INSERT INTO backup_subscriptions(id, owner_user_id, title, url, user_agent, hwid, enabled, created_at, updated_at)
     VALUES(@id, @owner, @title, @url, @ua, @hwid, @enabled, @now, @now)`,
  ).run({
    id,
    owner: p.ownerUserId ?? null,
    title: p.title ?? '',
    url: p.url,
    ua: p.userAgent ?? null,
    hwid: p.hwid ?? null,
    enabled: p.enabled === false ? 0 : 1,
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
    servers: Array<{ name: string; link: string; host: string; port: number; protocol: string }>;
    provider?: { upload?: number; download?: number; total?: number; expire?: number };
    etag?: string | null;
    lastModified?: string | null;
    error?: string | null;
  },
): void {
  const now = nowIso();
  const tx = db.transaction(() => {
    const p = r.provider ?? {};
    db.prepare(
      `UPDATE backup_subscriptions SET
         format = @format, sub_upload = @up, sub_download = @down, sub_total = @total, sub_expire = @expire,
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
    // Список серверов при успешном фетче перезаписываем целиком.
    if (!r.error) {
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

/** Резервный пул пользователя: общий пул (если есть привилегия) + его личные подписки. */
export function backupServerLinksForUser(
  userId: string,
): Array<{ subscriptionId: string; name: string; link: string; host: string; port: number }> {
  const user = getUser(userId);
  if (!user) return [];
  const subs = db
    .prepare(
      `SELECT id FROM backup_subscriptions
       WHERE enabled = 1 AND (owner_user_id = @uid OR (owner_user_id IS NULL AND @priority = 1))
       ORDER BY owner_user_id IS NULL DESC, created_at`,
    )
    .all({ uid: userId, priority: user.priorityAccess ? 1 : 0 }) as Array<{ id: string }>;
  const out: Array<{ subscriptionId: string; name: string; link: string; host: string; port: number }> = [];
  for (const s of subs) {
    const rows = db
      .prepare("SELECT * FROM backup_servers WHERE subscription_id = ? AND enabled = 1 AND link != '' ORDER BY sort")
      .all(s.id) as any[];
    for (const r of rows) out.push({ subscriptionId: s.id, name: r.name, link: r.link, host: r.host, port: r.port });
  }
  return out;
}

/** Есть ли у пользователя хоть один доступный резервный сервер. */
export function userHasBackup(userId: string): boolean {
  return backupServerLinksForUser(userId).length > 0;
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
