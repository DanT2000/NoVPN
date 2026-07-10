// Драйвер Xray (VLESS Reality). Порт логики Amnezia-стека под интерфейс NoVPN.
// Сохраняет старые UUID, на каждое устройство — отдельный UUID. Не трогает
// legacy inbound без необходимости; изменения проверяются `xray -test`.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config.js';
import { dockerCp, dockerCpTo, dockerExec, dockerRestart, dockerPs } from '../shell.js';
import type { AccessRef, CreatedAccess, DiscoveredAccess, DriverHealth, ProtocolDriver, TrafficSample } from './types.js';

const C = () => config.xrayContainer;
const CONF = () => config.xrayConfigPath;

async function getConfig(): Promise<any> {
  const tmp = path.join(os.tmpdir(), `xray_${Date.now()}.json`);
  await dockerCp(C(), CONF(), tmp);
  const content = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  fs.unlinkSync(tmp);
  return content;
}
async function writeConfig(cfg: unknown): Promise<void> {
  const tmp = path.join(os.tmpdir(), `xray_${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  await dockerCpTo(tmp, C(), CONF());
  fs.unlinkSync(tmp);
}

export const xrayDriver: ProtocolDriver = {
  protocol: 'xray',

  async detect() {
    const names = await dockerPs();
    return names.includes(C());
  },

  async healthcheck(): Promise<DriverHealth> {
    const running = (await dockerPs()).includes(C());
    if (!running) return { installed: false, healthy: false, note: 'контейнер xray не запущен' };
    try {
      await dockerExec(C(), 'xray', '-test', '-config', CONF());
      return { installed: true, healthy: true, note: 'конфигурация валидна' };
    } catch {
      return { installed: true, healthy: false, note: 'xray -test не прошёл' };
    }
  },

  async createAccess(deviceName: string): Promise<CreatedAccess> {
    const cfg = await getConfig();
    const uuid = (await dockerExec(C(), 'xray', 'uuid')).trim();
    const inbound = cfg.inbounds[0];
    inbound.settings ??= {};
    inbound.settings.clients ??= [];
    inbound.settings.clients.push({ flow: 'xtls-rprx-vision', id: uuid });

    const reality = inbound.streamSettings?.realitySettings ?? {};
    const serverPriv = reality.privateKey ?? '';
    const sni = (reality.serverNames ?? [])[0] ?? 'www.googletagmanager.com';
    const sid = (reality.shortIds ?? [])[0] ?? '';

    await writeConfig(cfg);
    await dockerExec(C(), 'xray', '-test', '-config', CONF());
    await dockerRestart(C());

    const pubRaw = await dockerExec(C(), 'sh', '-c', `echo '${serverPriv}' | xray x25519 -i /dev/stdin`);
    const publicKey = pubRaw.match(/Public key:\s*(.+)/)?.[1]?.trim() ?? serverPriv;

    const host = config.xrayEndpointHost || '127.0.0.1';
    const link =
      `vless://${uuid}@${host}:${config.xrayEndpointPort}?type=tcp&security=reality` +
      `&pbk=${encodeURIComponent(publicKey)}&fp=${config.xrayFingerprint}&sni=${encodeURIComponent(sni)}` +
      `&sid=${sid}&flow=xtls-rprx-vision&encryption=none#${encodeURIComponent(deviceName)}`;

    return { ref: { id: uuid }, link, meta: { publicKey } };
  },

  async importAccess(): Promise<DiscoveredAccess[]> {
    const cfg = await getConfig();
    const clients: Array<{ id: string; email?: string }> = cfg.inbounds?.[0]?.settings?.clients ?? [];
    return clients.map((c) => ({ ref: { id: c.id }, matchKey: c.id, note: c.email ?? undefined }));
  },

  async revokeAccess(ref: AccessRef): Promise<void> {
    const cfg = await getConfig();
    const inbound = cfg.inbounds[0];
    if (inbound.settings?.clients) {
      inbound.settings.clients = inbound.settings.clients.filter((c: { id: string }) => c.id !== ref.id);
    }
    await writeConfig(cfg);
    await dockerExec(C(), 'xray', '-test', '-config', CONF());
    await dockerRestart(C());
  },

  async getTraffic(): Promise<TrafficSample[]> {
    // Per-user статистика Xray требует включённого stats API. Если он не настроен —
    // честно сообщаем, что мониторинг недоступен (не выдаём нули за факт).
    const cfg = await getConfig();
    const clients: Array<{ id: string }> = cfg.inbounds?.[0]?.settings?.clients ?? [];
    return clients.map((c) => ({
      ref: { id: c.id },
      receivedBytes: null,
      sentBytes: null,
      lastHandshakeAt: null,
      available: false,
    }));
  },
};
