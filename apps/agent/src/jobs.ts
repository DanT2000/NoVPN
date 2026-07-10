// Выполнение заданий + очередь на случай потери связи. Задания идемпотентны.

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { xrayDriver } from './drivers/xray.js';
import { amneziawgDriver } from './drivers/amneziawg.js';
import { httpProxyDriver, socks5Driver } from './drivers/proxy.js';
import { runAudit } from './audit.js';
import type { ProtocolDriver } from './drivers/types.js';
import type { AgentJob } from './controlPlane.js';

const drivers: Record<string, ProtocolDriver> = {
  xray: xrayDriver,
  amneziawg: amneziawgDriver,
  http: httpProxyDriver,
  socks5: socks5Driver,
};

function driverFor(p: unknown): ProtocolDriver {
  const d = drivers[String(p)];
  if (!d) throw new Error(`Неизвестный протокол: ${String(p)}`);
  return d;
}

export async function runJob(job: AgentJob): Promise<unknown> {
  switch (job.type) {
    case 'create':
      return driverFor(job.payload.protocol).createAccess(String(job.payload.deviceName ?? 'device'));
    case 'revoke':
      return driverFor(job.payload.protocol).revokeAccess({ id: String(job.payload.ref) });
    case 'import': {
      const out: Record<string, unknown> = {};
      for (const [name, d] of Object.entries(drivers)) {
        if (await d.detect().catch(() => false)) out[name] = await d.importAccess().catch(() => []);
      }
      return out;
    }
    case 'audit':
      return runAudit();
    case 'traffic': {
      const out: Record<string, unknown> = {};
      for (const [name, d] of Object.entries(drivers)) {
        if (await d.detect().catch(() => false)) out[name] = await d.getTraffic().catch(() => []);
      }
      return out;
    }
    case 'healthcheck': {
      const out: Record<string, unknown> = {};
      for (const [name, d] of Object.entries(drivers)) out[name] = await d.healthcheck().catch(() => ({ installed: false, healthy: false, note: 'ошибка' }));
      return out;
    }
    default:
      throw new Error(`Неизвестный тип задания: ${(job as AgentJob).type}`);
  }
}

// ── offline outbox (результаты, не доставленные из-за потери связи) ──
interface OutboxEntry {
  jobId: string;
  result: unknown;
  error: string | null;
}
const outboxFile = () => path.join(config.dataDir, 'outbox.json');

export function readOutbox(): OutboxEntry[] {
  try {
    return JSON.parse(fs.readFileSync(outboxFile(), 'utf8')) as OutboxEntry[];
  } catch {
    return [];
  }
}
export function writeOutbox(entries: OutboxEntry[]): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(outboxFile(), JSON.stringify(entries), 'utf8');
}
export function enqueueResult(entry: OutboxEntry): void {
  const o = readOutbox();
  o.push(entry);
  writeOutbox(o);
}
