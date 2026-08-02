// Выпуск конфига пользователю. Общая логика для HTTP-роутов и Telegram-бота.

import type { IssueDeviceResult, ProxyAccount, Server, User } from '@novpn/shared';
import crypto from 'node:crypto';
import * as repo from '../repo.js';
import { config } from '../config.js';
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
  return sshCreateXray(server, name);
}
export async function createAwgCfg(server: Server, name: string) {
  if (!(await sshHasSshAccess(server.id))) throw new Error(NO_SSH);
  return sshCreateAwg(server, name);
}

export async function issueForUser(
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
    return { device, link: r.link, subscriptionUrl: repo.subscriptionUrl(user.id) ?? undefined };
  }
  const r = await createAwgCfg(server, name);
  const device = repo.insertDevice({
    userId: user.id, name, serverId, protocol, publicKey: r.publicKey,
    privateKeyEnc: encryptSecret(r.privateKey), presharedKeyEnc: encryptSecret(r.presharedKey),
    clientIp: r.clientIp, conf: r.conf,
  });
  repo.addHistory(user.id, `Выпущен конфиг «${name}» (AmneziaWG, ${server.name})`);
  // Ссылка vpn:// для приложения AmneziaVPN — импорт в один тап.
  // Отдельное приложение AmneziaWG её не принимает, ему нужен файл .conf.
  const vpnKey = vpnLinkFromConf(r.conf, `${config.appName} — ${server.name}`);
  return {
    device, conf: r.conf, vpnKeyAvailable: !!vpnKey, vpnKey: vpnKey ?? undefined,
    vpnKeyNote: vpnKey
      ? 'Ссылка vpn:// — для приложения AmneziaVPN. Для отдельного приложения AmneziaWG используйте файл .conf.'
      : undefined,
  };
}

/** Отозвать ВСЕ активные конфиги/прокси пользователя на серверах — при отключении,
 *  удалении или истечении доступа. Иначе уже импортированный конфиг продолжал бы
 *  работать на VPN-сервере бессрочно. Best-effort: сбой одного сервера не мешает
 *  остальным; отзыв в БД делает вызывающий отдельно. */
export async function revokeUserAccessOnServers(userId: string): Promise<void> {
  for (const d of repo.listDevicesOfUser(userId)) {
    if (!d.isActive) continue;
    const row = repo.getDeviceRow(d.id);
    const server = repo.getServer(d.serverId);
    if (!row || !server || !(await sshHasSshAccess(server.id))) continue;
    try {
      if (row.protocol === 'xray' && row.uuid) await sshRevokeXray(server, row.uuid);
      else if (row.protocol === 'amneziawg' && row.public_key) await sshRevokeAwg(server, row.public_key);
    } catch {
      /* best-effort: сервер недоступен — отзыв в БД всё равно состоится */
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
