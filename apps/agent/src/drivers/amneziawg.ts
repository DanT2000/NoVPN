// Драйвер AmneziaWG. Порт логики Amnezia-стека. Отдаёт нативный .conf.
// Различие .conf ↔ официальный vpn:// решается на стороне панели/клиента:
// драйвер честно отдаёт .conf и НЕ выдаёт его за vpn://.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config.js';
import { dockerCp, dockerCpTo, dockerExec, dockerExecStdin, dockerPs } from '../shell.js';
import type { AccessRef, CreatedAccess, DiscoveredAccess, DriverHealth, ProtocolDriver, TrafficSample } from './types.js';

const C = () => config.awgContainer;
const IFACE = () => config.awgInterface;
const CONF = () => config.awgConfigPath;

async function getConf(): Promise<string> {
  const tmp = path.join(os.tmpdir(), `awg_${Date.now()}.conf`);
  await dockerCp(C(), CONF(), tmp);
  const content = fs.readFileSync(tmp, 'utf8');
  fs.unlinkSync(tmp);
  return content;
}
async function writeConf(content: string): Promise<void> {
  const tmp = path.join(os.tmpdir(), `awg_${Date.now()}.conf`);
  fs.writeFileSync(tmp, content, 'utf8');
  await dockerCpTo(tmp, C(), CONF());
  fs.unlinkSync(tmp);
}
const param = (content: string, key: string, def: string) =>
  content.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm'))?.[1]?.trim() ?? def;

function nextFreeIp(content: string): string {
  const used = [...content.matchAll(/AllowedIPs\s*=\s*([0-9.]+)\/32/g)].map((m) => m[1]);
  for (let i = 2; i < 255; i++) {
    const ip = `${config.awgBaseNet}.${i}`;
    if (!used.includes(ip)) return ip;
  }
  throw new Error('Нет свободных IP в подсети AmneziaWG');
}

function parseHandshake(text: string): string | null {
  const t = (text || '').trim();
  if (!t || /never/i.test(t)) return null;
  // «X seconds/minutes/hours/days ago» → приблизительная метка.
  const now = Date.now();
  const num = Number(t.match(/(\d+)/)?.[1] ?? 0);
  const mult = /day/.test(t) ? 86400000 : /hour/.test(t) ? 3600000 : /minute/.test(t) ? 60000 : 1000;
  return new Date(now - num * mult).toISOString();
}
function bytesFrom(s: string): number | null {
  const m = s.match(/([0-9.]+)\s*(\w+)/);
  if (!m) return null;
  const n = Number(m[1]);
  const u = (m[2] || '').toLowerCase();
  const k = u.startsWith('gib') || u.startsWith('gb') ? 1e9 : u.startsWith('mib') || u.startsWith('mb') ? 1e6 : u.startsWith('kib') || u.startsWith('kb') ? 1e3 : 1;
  return Math.round(n * k);
}

export const amneziawgDriver: ProtocolDriver = {
  protocol: 'amneziawg',

  async detect() {
    return (await dockerPs()).includes(C());
  },

  async healthcheck(): Promise<DriverHealth> {
    const running = (await dockerPs()).includes(C());
    if (!running) return { installed: false, healthy: false, note: 'контейнер AmneziaWG не запущен' };
    try {
      await dockerExec(C(), 'awg', 'show', IFACE());
      return { installed: true, healthy: true, note: 'интерфейс поднят' };
    } catch {
      return { installed: true, healthy: false, note: `awg show ${IFACE()} не отвечает` };
    }
  },

  async createAccess(deviceName: string): Promise<CreatedAccess> {
    const content = await getConf();
    const clientPriv = (await dockerExec(C(), 'awg', 'genkey')).trim();
    const clientPub = (await dockerExecStdin(C(), clientPriv, 'awg', 'pubkey')).trim();
    const psk = (await dockerExec(C(), 'awg', 'genpsk')).trim();

    const serverPriv = content.match(/^PrivateKey\s*=\s*(.+)$/m)?.[1]?.trim();
    if (!serverPriv) throw new Error('Не найден серверный PrivateKey в awg0.conf');
    const serverPub = (await dockerExecStdin(C(), serverPriv, 'awg', 'pubkey')).trim();

    const clientIp = nextFreeIp(content);
    const j = {
      Jc: param(content, 'Jc', '4'), Jmin: param(content, 'Jmin', '40'), Jmax: param(content, 'Jmax', '70'),
      S1: param(content, 'S1', '0'), S2: param(content, 'S2', '0'), S3: param(content, 'S3', '0'), S4: param(content, 'S4', '0'),
      H1: param(content, 'H1', '1'), H2: param(content, 'H2', '2'), H3: param(content, 'H3', '3'), H4: param(content, 'H4', '4'),
    };

    const peerBlock = `\n[Peer]\n# ${deviceName}\nPublicKey = ${clientPub}\nPresharedKey = ${psk}\nAllowedIPs = ${clientIp}/32\n`;
    await writeConf(content + peerBlock);
    // Применяем на живой интерфейс идемпотентно (psk через stdin, не в argv).
    await dockerExecStdin(C(), psk, 'awg', 'set', IFACE(), 'peer', clientPub, 'preshared-key', '/dev/stdin', 'allowed-ips', `${clientIp}/32`);

    const host = config.awgEndpointHost || '127.0.0.1';
    const conf = `[Interface]
PrivateKey = ${clientPriv}
Address = ${clientIp}/32
DNS = 1.1.1.1
Jc = ${j.Jc}
Jmin = ${j.Jmin}
Jmax = ${j.Jmax}
S1 = ${j.S1}
S2 = ${j.S2}
S3 = ${j.S3}
S4 = ${j.S4}
H1 = ${j.H1}
H2 = ${j.H2}
H3 = ${j.H3}
H4 = ${j.H4}

[Peer]
PublicKey = ${serverPub}
PresharedKey = ${psk}
Endpoint = ${host}:${config.awgEndpointPort}
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 25`;

    return { ref: { id: clientPub }, conf, meta: { clientIp, privateKey: clientPriv, presharedKey: psk } };
  },

  async importAccess(): Promise<DiscoveredAccess[]> {
    const content = await getConf();
    const peers = [...content.matchAll(/\[Peer\]([\s\S]*?)(?=\n\[Peer\]|\n*$)/g)];
    const out: DiscoveredAccess[] = [];
    for (const m of peers) {
      const block = m[1] ?? '';
      const pub = block.match(/PublicKey\s*=\s*(.+)/)?.[1]?.trim();
      if (!pub) continue;
      const name = block.match(/#\s*(.+)/)?.[1]?.trim();
      out.push({ ref: { id: pub }, matchKey: pub, note: name });
    }
    return out;
  },

  async revokeAccess(ref: AccessRef): Promise<void> {
    await dockerExec(C(), 'awg', 'set', IFACE(), 'peer', ref.id, 'remove');
    const content = await getConf();
    const esc = ref.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const cleaned = content.replace(new RegExp(`\\n\\[Peer\\][^[]*PublicKey\\s*=\\s*${esc}[^[]*`, 's'), '\n');
    await writeConf(cleaned);
  },

  async getTraffic(): Promise<TrafficSample[]> {
    let raw: string;
    try {
      raw = await dockerExec(C(), 'awg', 'show', IFACE());
    } catch {
      return [];
    }
    const blocks = raw.split(/\npeer: /).slice(1);
    return blocks.map((block) => {
      const lines = block.split('\n');
      const pub = (lines[0] ?? '').trim();
      const hs = block.match(/latest handshake:\s*([^\n]+)/)?.[1] ?? '';
      const tr = block.match(/transfer:\s*([0-9.]+ \w+) received,\s*([0-9.]+ \w+) sent/);
      return {
        ref: { id: pub },
        receivedBytes: tr ? bytesFrom(tr[1]!) : null,
        sentBytes: tr ? bytesFrom(tr[2]!) : null,
        lastHandshakeAt: parseHandshake(hs),
        available: true,
      };
    });
  },
};
