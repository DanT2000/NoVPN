// Выпуск конфига пользователю. Общая логика для HTTP-роутов и Telegram-бота.

import type { IssueDeviceResult, ProxyAccount, Server, User } from '@novpn/shared';
import crypto from 'node:crypto';
import * as repo from '../repo.js';
import { encryptSecret } from '../lib/crypto.js';
import { sshHasSshAccess, sshCreateXray, sshCreateAwg, sshAddProxyUser, sshRevokeXray, sshRevokeAwg, sshRevokeProxyUser } from './sshServer.js';
import { vpnLinkFromConf } from './amneziaLink.js';

const NO_SSH =
  'Для сервера не задан SSH-доступ — панель не может выпустить рабочий конфиг. ' +
  'Откройте «Серверы» → «Изменить» и укажите пароль или приватный ключ.';

// Выпуск конфига — ТОЛЬКО по SSH на реальном сервере.
// Раньше при отсутствии SSH возвращался mock-конфиг: он выглядел настоящим, но не работал.
// Лучше честная ошибка, чем нерабочий конфиг на руках у пользователя.
export async function createXrayCfg(server: Server, name: string) {
  if (!(await sshHasSshAccess(server.id))) throw new Error(NO_SSH);
  return sshCreateXray(server, name, repo.brandName(), repo.getEndpointPorts(server.host).xray);
}
export async function createAwgCfg(server: Server, name: string) {
  if (!(await sshHasSshAccess(server.id))) throw new Error(NO_SSH);
  return sshCreateAwg(server, name, repo.getEndpointPorts(server.host).awg);
}

// Сериализация выпуска ПО ПОЛЬЗОВАТЕЛЮ: check-then-act (посчитать активные → SSH →
// insertDevice) не атомарен через await. Без блокировки N параллельных POST /devices
// прошли бы лимит AmneziaWG или наплодили дублей Xray. Цепочка промисов на пользователя.
const userIssueLocks = new Map<string, Promise<unknown>>();
export function withUserIssueLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = userIssueLocks.get(userId) ?? Promise.resolve();
  const run = prev.then(fn, fn); // ждём предыдущую выдачу (успех/ошибку — неважно)
  userIssueLocks.set(userId, run.then(() => {}, () => {})); // одна запись на пользователя (не растёт)
  return run;
}

export function issueForUser(
  user: User,
  name: string,
  serverId: string,
  protocol: 'xray' | 'amneziawg',
  opts: { byAdmin?: boolean } = {},
): Promise<IssueDeviceResult> {
  return withUserIssueLock(user.id, () => issueForUserInner(user, name, serverId, protocol, opts));
}

async function issueForUserInner(
  user: User,
  name: string,
  serverId: string,
  protocol: 'xray' | 'amneziawg',
  opts: { byAdmin?: boolean } = {},
): Promise<IssueDeviceResult> {
  const server = repo.getServer(serverId);
  if (!server) throw new Error('Сервер не найден.');
  // Доступ проверяем ЗДЕСЬ, в общей функции выпуска: иначе пути в обход UI-шага
  // (напр. старая inline-кнопка в боте) могли выпустить конфиг отключённому или
  // истёкшему пользователю. Админ (byAdmin) не ограничен статусом/сроком.
  if (!opts.byAdmin) {
    if (!user.isActive) throw new Error('Доступ отключён.');
    if (user.expiresAt && new Date(user.expiresAt) < new Date()) throw new Error('Срок действия доступа истёк.');
    // Квота: раньше лимит трафика блокировал только вход, но не выпуск конфигов —
    // вошедший с исчерпанной квотой продолжал плодить конфиги. Теперь проверяем.
    if (user.trafficLimitGb != null && user.trafficUsedGb >= user.trafficLimitGb)
      throw new Error('Лимит трафика исчерпан. Обратитесь к администратору.');
  }
  if (!user.allowedServers.includes(serverId)) throw new Error('Сервер недоступен для этого пользователя.');
  if (!user.allowedProtocols.includes(protocol)) throw new Error('Протокол недоступен для этого пользователя.');
  if (!server.protocols.includes(protocol)) throw new Error('Сервер не поддерживает этот протокол.');
  // Автовыдача выключена админом — пользователь (кабинет, бот) выпустить не может.
  // Сам админ из панели выпускает всегда: тумблер про самообслуживание, не про него.
  if (!server.autoIssue && !opts.byAdmin)
    throw new Error('Самостоятельная выдача конфигов на этом сервере временно отключена. Обратитесь к администратору.');

  // Лимит устройств — это лимит AmneziaWG-устройств (у каждого свои ключи = отдельное
  // устройство). Xray — ОДНА общая подписка на любое число устройств, лимитом устройств
  // не ограничивается вовсе (контроль только по трафику). Считаем только активные AWG.
  const atAwgDeviceLimit = (): boolean =>
    !opts.byAdmin && user.deviceLimit != null && repo.countActiveDevices(user.id, 'amneziawg') >= user.deviceLimit;

  if (protocol === 'xray') {
    // Одна Xray-конфигурация работает на любом числе устройств. Если у
    // пользователя на этом сервере уже есть активный Xray-конфиг — переиспользуем
    // его (подписка одна на всех), а не плодим по конфигу на каждое устройство.
    const existing = repo.findActiveXrayDevice(user.id, serverId);
    if (existing) {
      return { device: existing, link: existing.link ?? undefined, reused: true, subscriptionUrl: repo.subscriptionUrl(user.id) ?? undefined };
    }
    const r = await createXrayCfg(server, name);
    const device = repo.insertDevice({ userId: user.id, name, serverId, protocol, uuid: r.uuid, publicKey: r.publicKey, link: r.link });
    repo.addHistory(user.id, `Выпущен конфиг «${name}» (Xray, ${server.name})`);
    // Аварийный прокси-фоллбэк: заводим прокси-аккаунт (best-effort), если пользователю
    // разрешены прокси и они установлены на сервере — тогда полный конфиг (/full) сможет
    // переключиться на прокси, если Xray заблокируют. Аккаунт переиспользуется, удаляется
    // вместе с пользователем/при отключении. Сбой прокси не мешает выпуску Xray.
    if (repo.availableProxyTypes(user, server).length > 0) {
      try {
        await issueProxyForUser(user, serverId, { byAdmin: opts.byAdmin });
      } catch {
        /* прокси недоступны/самовыдача выключена — не критично для Xray */
      }
    }
    return { device, link: r.link, subscriptionUrl: repo.subscriptionUrl(user.id) ?? undefined };
  }
  if (atAwgDeviceLimit())
    throw new Error(`Достигнут лимит устройств AmneziaWG (${user.deviceLimit}). Отключите старое устройство или обратитесь к администратору.`);
  const r = await createAwgCfg(server, name);
  const device = repo.insertDevice({
    userId: user.id, name, serverId, protocol, publicKey: r.publicKey,
    privateKeyEnc: encryptSecret(r.privateKey), presharedKeyEnc: encryptSecret(r.presharedKey),
    clientIp: r.clientIp, conf: r.conf,
  });
  repo.addHistory(user.id, `Выпущен конфиг «${name}» (AmneziaWG, ${server.name})`);
  // Ссылка vpn:// для приложения AmneziaVPN — импорт в один тап.
  // Отдельное приложение AmneziaWG её не принимает, ему нужен файл .conf.
  const vpnKey = vpnLinkFromConf(r.conf, `${repo.brandName()} — ${server.name}`);
  return {
    device, conf: r.conf, vpnKeyAvailable: !!vpnKey, vpnKey: vpnKey ?? undefined,
    vpnKeyNote: vpnKey
      ? 'Ссылка vpn:// — для приложения AmneziaVPN. Для отдельного приложения AmneziaWG используйте файл .conf.'
      : undefined,
  };
}

/** Отозвать ОДНО устройство на его сервере. Возвращает true, если отзыв подтверждён
 *  (или отзывать нечего — нет ключей), и false, если сервер был, но отозвать не
 *  удалось (недоступен/ошибка). По false вызывающий НЕ должен физически удалять
 *  запись, иначе живой конфиг осиротеет на сервере без возможности переотзыва. */
export async function revokeDeviceOnServer(deviceId: string): Promise<boolean> {
  const row = repo.getDeviceRow(deviceId);
  if (!row) return true;
  const server = repo.getServer(row.server_id);
  if (!server) return true; // сервера нет — переотзывать негде, удалять запись безопасно
  if (!(await sshHasSshAccess(server.id))) return false; // временно нет доступа — не удаляем
  try {
    if (row.protocol === 'xray' && row.uuid) await sshRevokeXray(server, row.uuid);
    else if (row.protocol === 'amneziawg' && row.public_key) await sshRevokeAwg(server, row.public_key);
    return true;
  } catch {
    return false; // сервер недоступен/ошибка — оставим запись для повторного отзыва
  }
}

/** Отозвать ВСЕ активные конфиги/прокси пользователя на серверах — при отключении,
 *  удалении или истечении доступа. Иначе уже импортированный конфиг продолжал бы
 *  работать на VPN-сервере бессрочно. Возвращает id устройств, чей серверный отзыв
 *  ПОДТВЕРЖДЁН (успех, либо отзывать нечего/сервер не управляется). Не попавшие в
 *  список — «отзыв ожидает» (сервер был недоступен): вызывающий пометит их
 *  revoke_pending, и sync повторит отзыв, чтобы утёкший конфиг не жил вечно. */
export async function revokeUserAccessOnServers(userId: string): Promise<{ confirmed: string[] }> {
  const confirmed: string[] = [];
  for (const d of repo.listDevicesOfUser(userId)) {
    if (!d.isActive) continue;
    const row = repo.getDeviceRow(d.id);
    const server = repo.getServer(d.serverId);
    if (!server) { confirmed.push(d.id); continue; } // сервер не управляется панелью — отзывать негде
    if (!(await sshHasSshAccess(server.id))) continue; // временно нет доступа — оставим pending
    try {
      if (row?.protocol === 'xray' && row.uuid) await sshRevokeXray(server, row.uuid);
      else if (row?.protocol === 'amneziawg' && row.public_key) await sshRevokeAwg(server, row.public_key);
      confirmed.push(d.id); // отозвали или отзывать было нечего
    } catch {
      /* сервер недоступен — НЕ подтверждаем: sync повторит отзыв */
    }
  }
  for (const acc of repo.listProxyAccountRowsOfUser(userId)) {
    const server = repo.getServer(acc.server_id);
    if (!server || !(await sshHasSshAccess(server.id))) continue;
    try {
      await sshRevokeProxyUser(server, acc.login);
    } catch {
      /* best-effort */
    }
  }
  return { confirmed };
}

const rand = (n: number) => crypto.randomBytes(n).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, n);
const sanLogin = (s: string) => (s.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12) || 'user');

/** Выдать пользователю прокси-аккаунт на сервере (один логин на пользователя+
 *  сервер, работает для всех установленных и разрешённых типов прокси). Если
 *  аккаунт уже есть — возвращаем его (та же учётка). */
export async function issueProxyForUser(user: User, serverId: string, opts: { byAdmin?: boolean } = {}): Promise<ProxyAccount> {
  const server = repo.getServer(serverId);
  if (!server) throw new Error('Сервер не найден.');
  if (!opts.byAdmin) {
    if (!user.isActive) throw new Error('Доступ отключён.');
    if (user.expiresAt && new Date(user.expiresAt) < new Date()) throw new Error('Срок действия доступа истёк.');
    if (user.trafficLimitGb != null && user.trafficUsedGb >= user.trafficLimitGb)
      throw new Error('Лимит трафика исчерпан. Обратитесь к администратору.');
  }
  if (!user.allowedServers.includes(serverId)) throw new Error('Сервер недоступен для этого пользователя.');
  const types = repo.availableProxyTypes(user, server);
  if (types.length === 0)
    throw new Error('На этом сервере нет доступных вам прокси (не установлены или не разрешены).');
  if (!server.autoIssue && !opts.byAdmin)
    throw new Error('Самостоятельная выдача на этом сервере временно отключена. Обратитесь к администратору.');
  if (!(await sshHasSshAccess(server.id))) throw new Error('Для сервера не задан SSH-доступ.');

  const existing = repo.findActiveProxyAccount(user.id, serverId);
  if (existing) return repo.buildProxyAccountView(existing)!;

  const login = `${sanLogin(user.name)}${rand(5)}`;
  const password = rand(16);
  await sshAddProxyUser(server, login, password);
  const row = repo.insertProxyAccountRow({ userId: user.id, serverId, login, passEnc: encryptSecret(password) });
  repo.addHistory(user.id, `Выдан прокси-доступ (${types.join('/')}, ${server.name})`);
  return repo.buildProxyAccountView(row)!;
}
