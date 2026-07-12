// Выпуск конфига пользователю. Общая логика для HTTP-роутов и Telegram-бота.

import type { IssueDeviceResult, Server, User } from '@novpn/shared';
import * as repo from '../repo.js';
import { encryptSecret } from '../lib/crypto.js';
import { agentService } from './agent.js';
import { sshHasSshAccess, sshCreateXray, sshCreateAwg } from './sshServer.js';

// Выпуск конфига: по SSH (реальный сервер) или через mock-агент (dev).
export async function createXrayCfg(server: Server, name: string) {
  return (await sshHasSshAccess(server.id)) ? sshCreateXray(server, name) : agentService.createXray(server, name);
}
export async function createAwgCfg(server: Server, name: string) {
  return (await sshHasSshAccess(server.id)) ? sshCreateAwg(server, name) : agentService.createAmneziaWG(server, name);
}

export async function issueForUser(
  user: User,
  name: string,
  serverId: string,
  protocol: 'xray' | 'amneziawg',
): Promise<IssueDeviceResult> {
  const server = repo.getServer(serverId);
  if (!server) throw new Error('Сервер не найден.');
  if (!user.allowedServers.includes(serverId)) throw new Error('Сервер недоступен для этого пользователя.');
  if (!user.allowedProtocols.includes(protocol)) throw new Error('Протокол недоступен для этого пользователя.');
  if (!server.protocols.includes(protocol)) throw new Error('Сервер не поддерживает этот протокол.');

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
  return {
    device, conf: r.conf, vpnKeyAvailable: false,
    vpnKeyNote: 'Официальный ключ vpn:// пока недоступен через текущий стек. Используйте .conf в совместимых приложениях.',
  };
}
