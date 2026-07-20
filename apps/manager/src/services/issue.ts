// Выпуск конфига пользователю. Общая логика для HTTP-роутов и Telegram-бота.

import type { IssueDeviceResult, Server, User } from '@novpn/shared';
import * as repo from '../repo.js';
import { config } from '../config.js';
import { encryptSecret } from '../lib/crypto.js';
import { sshHasSshAccess, sshCreateXray, sshCreateAwg } from './sshServer.js';
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
  if (!user.allowedServers.includes(serverId)) throw new Error('Сервер недоступен для этого пользователя.');
  if (!user.allowedProtocols.includes(protocol)) throw new Error('Протокол недоступен для этого пользователя.');
  if (!server.protocols.includes(protocol)) throw new Error('Сервер не поддерживает этот протокол.');
  // Автовыдача выключена админом — пользователь (кабинет, бот) выпустить не может.
  // Сам админ из панели выпускает всегда: тумблер про самообслуживание, не про него.
  if (!server.autoIssue && !opts.byAdmin)
    throw new Error('Самостоятельная выдача конфигов на этом сервере временно отключена. Обратитесь к администратору.');

  if (protocol === 'xray') {
    const r = await createXrayCfg(server, name);
    const device = repo.insertDevice({ userId: user.id, name, serverId, protocol, uuid: r.uuid, publicKey: r.publicKey, link: r.link });
    repo.addHistory(user.id, `Выпущен конфиг «${name}» (Xray, ${server.name})`);
    return { device, link: r.link };
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
