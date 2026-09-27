// Перевыпуск подписки пользователя. Сценарий: человек поделился подпиской (или
// личной ссылкой) с другом и хочет отозвать доступ. Заменяем ВСЁ, что могло уйти
// на сторону, — по отдельности ни один шаг доступ не отрезает:
//  • адрес подписки /sub/<токен> — иначе приложение друга скачает свежие ключи
//    при следующем обновлении;
//  • ключи Xray на серверах — иначе уже импортированные vless:// у друга работают;
//  • личная ссылка /k/<токен> — через неё друг снова получил бы подписку;
//  • чужие входы в кабинет — сессия живёт до 7 дней;
//  • прокси-логины — они вшиты в /full как аварийный выход.
// Конфиги AmneziaWG не трогаем: у каждого устройства свои ключи, их перевыпускают
// поштучно в «Моих устройствах», а в подписку они не входят.

import type { RotateSubscriptionResult, Server, User } from '@novpn/shared';
import * as repo from '../repo.js';
import { createXrayCfg, issueProxyForUser, withUserIssueLock } from './issue.js';
import { sshHasSshAccess, sshRevokeXray, sshRevokeProxyUser } from './sshServer.js';
import { destroyUserSessions } from './sessionStore.js';
import { notifyUser } from './telegram.js';

/** Самостоятельный перевыпуск из кабинета — не чаще раза в столько минут: каждый
 *  перевыпуск перезапускает Xray на серверах, и на секунду рвётся связь у ВСЕХ. */
export const SELF_ROTATE_COOLDOWN_MIN = 10;

/** Операции с серверами. Вынесены, чтобы проверять логику тестом без SSH. */
export interface RotateDeps {
  hasSsh(serverId: string): Promise<boolean>;
  revokeXray(server: Server, uuid: string): Promise<unknown>;
  createXray(server: Server, name: string): Promise<{ uuid: string; publicKey: string; link: string }>;
  revokeProxy(server: Server, login: string): Promise<unknown>;
  issueProxy(user: User, serverId: string): Promise<unknown>;
  notify(userId: string, text: string): Promise<boolean>;
  destroySessions(userId: string, exceptSid?: string): number;
}

const defaultDeps: RotateDeps = {
  hasSsh: sshHasSshAccess,
  revokeXray: sshRevokeXray,
  createXray: createXrayCfg,
  revokeProxy: sshRevokeProxyUser,
  // Замена уже выданного логина, а не новая выдача: тумблер самовыдачи сервера тут
  // ни при чём, поэтому byAdmin. Разрешённость сервера/типов проверяется как обычно.
  issueProxy: (user, serverId) => issueProxyForUser(user, serverId, { byAdmin: true }),
  notify: notifyUser,
  destroySessions: destroyUserSessions,
};

/** Сколько минут ещё ждать до следующего самостоятельного перевыпуска (0 — можно). */
export function selfRotateWaitMin(userId: string, now = Date.now()): number {
  const last = repo.getSubRotatedAt(userId);
  if (!last) return 0;
  const left = new Date(last).getTime() + SELF_ROTATE_COOLDOWN_MIN * 60_000 - now;
  return left > 0 ? Math.ceil(left / 60_000) : 0;
}

export function rotateSubscription(
  userId: string,
  opts: { origin?: string; keepSid?: string; by: 'admin' | 'user' },
  deps: RotateDeps = defaultDeps,
): Promise<RotateSubscriptionResult> {
  // Под той же блокировкой, что выдача/перевыпуск устройств: параллельный выпуск
  // иначе мог бы создать конфиг по старой схеме посреди замены.
  return withUserIssueLock(userId, () => rotateInner(userId, opts, deps));
}

async function rotateInner(
  userId: string,
  opts: { origin?: string; keepSid?: string; by: 'admin' | 'user' },
  deps: RotateDeps,
): Promise<RotateSubscriptionResult> {
  const user = repo.getUser(userId);
  if (!user) throw new Error('Пользователь не найден.');

  // Сначала то, что отрезает мгновенно и без серверов: адреса и входы. Серверная
  // часть идёт по SSH и может занять время — друг не должен успеть обновиться.
  repo.markSubRotated(userId);
  repo.resetSubToken(userId);
  const accessToken = repo.resetAccessToken(userId);
  const sessionsClosed = deps.destroySessions(userId, opts.keepSid);

  const failed = new Set<string>();
  let rotated = 0;
  for (const d of repo.listDevicesOfUser(userId)) {
    if (!d.isActive || d.protocol !== 'xray') continue;
    const row = repo.getDeviceRow(d.id);
    if (!row || row.revoke_pending) continue;
    const server = repo.getServer(d.serverId);
    if (!server) continue;

    // Отзыв старого ключа ДО выпуска нового — как при перевыпуске устройства.
    let revoked = false;
    try {
      if (await deps.hasSsh(server.id)) {
        if (row.uuid) await deps.revokeXray(server, row.uuid);
        revoked = true;
      }
    } catch {
      revoked = false;
    }
    if (!revoked) {
      // Сервер недоступен: ключ снимаем в панели (из подписки он уходит сразу) и
      // ставим в очередь отзыва — sync удалит его с сервера, когда тот оживёт.
      // Молча оставить старый ключ нельзя: ради его отзыва перевыпуск и жмут.
      repo.updateDeviceFields(d.id, { is_active: 0, revoked_at: null, revoke_pending: 1 });
      failed.add(server.name);
      continue;
    }
    try {
      const r = await deps.createXray(server, d.name);
      // quota_blocked: 0 — как в перевыпуске устройства: свежий пир; если человек всё
      // ещё сверх лимита, следующий цикл sync снимет его снова.
      repo.updateDeviceFields(d.id, {
        is_active: 1, revoked_at: null, revoke_pending: 0, quota_blocked: 0,
        uuid: r.uuid, public_key: r.publicKey, link: r.link, conf: null,
      });
      rotated += 1;
    } catch {
      // Старый уже отозван, новый не выдался — конфиг для этого сервера выпускают заново.
      repo.updateDeviceFields(d.id, { is_active: 0, revoked_at: repo.nowIso(), revoke_pending: 0 });
      failed.add(server.name);
    }
  }

  let proxiesRotated = 0;
  for (const acc of repo.listProxyAccountRowsOfUser(userId)) {
    const server = repo.getServer(acc.server_id);
    if (!server) continue;
    try {
      if (!(await deps.hasSsh(server.id))) throw new Error('no ssh');
      await deps.revokeProxy(server, acc.login);
    } catch {
      // Не смогли снять старый логин — оставляем как есть (он виден в кабинете), а
      // сервер попадает в список «не удалось»: перевыпуск можно повторить.
      failed.add(server.name);
      continue;
    }
    repo.deactivateProxyAccount(acc.id);
    try {
      await deps.issueProxy(user, acc.server_id);
      proxiesRotated += 1;
    } catch {
      failed.add(server.name);
    }
  }

  const base = repo.publicBaseUrl(opts.origin);
  const accessLink = base ? `${base}/k/${accessToken}` : null;
  const who = opts.by === 'admin' ? 'администратором' : 'самим пользователем';
  repo.addHistory(userId, `Подписка перевыпущена ${who}: новых ключей Xray ${rotated}, прокси ${proxiesRotated}`);
  repo.addLog(`Перевыпущена подписка «${user.name}» (${who})${failed.size ? `; не удалось: ${[...failed].join(', ')}` : ''}`);

  // Новая личная ссылка — в Telegram, если привязан: так она не потеряется.
  const telegramNotified = accessLink
    ? await deps.notify(
        userId,
        `Подписка перевыпущена. Старые ссылки и ключи больше не работают.\n\n` +
          `Ваша новая личная ссылка:\n${accessLink}\n\n` +
          `Откройте её и заново добавьте подписку в приложения на своих устройствах.`,
      )
    : false;

  return {
    accessLink,
    subLink: repo.subscriptionUrl(userId, opts.origin),
    rotated,
    failedServers: [...failed],
    proxiesRotated,
    sessionsClosed,
    telegramNotified,
  };
}
