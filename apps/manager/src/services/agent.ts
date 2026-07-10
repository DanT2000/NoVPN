// Фасад к NoVPN Agent. В mock-режиме (ENABLE_MOCK_AGENT) конфиги генерируются
// локально — для разработки и dev-стенда без реального сервера. В реальном
// режиме операция ставится заданием, которое выполняет агент на VPN-сервере.

import crypto from 'node:crypto';
import type { Server } from '@novpn/shared';
import { config } from '../config.js';

export interface XrayResult {
  uuid: string;
  link: string;
  publicKey: string;
}
export interface AwgResult {
  clientIp: string;
  publicKey: string;
  privateKey: string;
  presharedKey: string;
  conf: string;
}

const b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const rnd44 = () => Array.from({ length: 43 }, () => b64[crypto.randomInt(64)]).join('') + '=';

export function genUuid(): string {
  return crypto.randomUUID();
}

function mockXray(server: Server, deviceName: string): XrayResult {
  const uuid = genUuid();
  const pbk = rnd44();
  const link =
    `vless://${uuid}@${server.host}:443?type=tcp&security=reality&flow=xtls-rprx-vision` +
    `&pbk=${pbk}&sid=6ba85179&sni=yahoo.com&fp=chrome&encryption=none#NoVPN-${encodeURIComponent(deviceName)}`;
  return { uuid, link, publicKey: pbk };
}

function mockAwg(server: Server, deviceName: string): AwgResult {
  const octet = 2 + (crypto.randomInt(250));
  const clientIp = `10.8.1.${octet}`;
  const privateKey = rnd44();
  const publicKey = rnd44();
  const presharedKey = rnd44();
  const conf = `[Interface]
PrivateKey = ${privateKey}
Address = ${clientIp}/32
DNS = 1.1.1.1, 1.0.0.1
Jc = 4
Jmin = 40
Jmax = 70
S1 = 86
S2 = 97
H1 = 1004746675
H2 = 928473625
H3 = 1719083348
H4 = 1339303396

[Peer]
PublicKey = ${publicKey}
PresharedKey = ${presharedKey}
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = ${server.host}:51820
PersistentKeepalive = 25`;
  void deviceName;
  return { clientIp, publicKey, privateKey, presharedKey, conf };
}

export const agentService = {
  mockEnabled: config.enableMockAgent,

  async createXray(server: Server, deviceName: string): Promise<XrayResult> {
    if (config.enableMockAgent) return mockXray(server, deviceName);
    // TODO(real-agent): поставить задание createAccess(xray) и дождаться результата.
    throw new Error('Реальный агент ещё не подключён к этому серверу. Включите ENABLE_MOCK_AGENT для dev.');
  },

  async createAmneziaWG(server: Server, deviceName: string): Promise<AwgResult> {
    if (config.enableMockAgent) return mockAwg(server, deviceName);
    throw new Error('Реальный агент ещё не подключён к этому серверу. Включите ENABLE_MOCK_AGENT для dev.');
  },

  async revoke(_server: Server, _ref: { uuid?: string; publicKey?: string }): Promise<void> {
    if (config.enableMockAgent) return;
    throw new Error('Реальный агент ещё не подключён.');
  },
};
