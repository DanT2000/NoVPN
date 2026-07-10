// Read-only аудит сервера. Ничего не меняет. Находит контейнеры/службы и
// установленные протоколы для отчёта в панель и импорта legacy-конфигов.

import { dockerPs, ok, run } from './shell.js';
import { xrayDriver } from './drivers/xray.js';
import { amneziawgDriver } from './drivers/amneziawg.js';
import { httpProxyDriver } from './drivers/proxy.js';

export interface AuditReport {
  os: string;
  dockerInstalled: boolean;
  containers: string[];
  detected: {
    xray: boolean;
    amneziawg: boolean;
    wireguard: boolean;
    proxy: boolean;
  };
  discovered: {
    xrayUuids: string[];
    awgPublicKeys: string[];
  };
  notes: string[];
}

export async function runAudit(): Promise<AuditReport> {
  const notes: string[] = [];
  let osName = 'unknown';
  try {
    osName = (await run('sh', ['-c', '. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME"'])).trim() || 'unknown';
  } catch {
    /* ignore */
  }

  const dockerInstalled = await ok('docker', ['version', '--format', '{{.Server.Version}}']);
  const containers = dockerInstalled ? await dockerPs() : [];

  const xray = await xrayDriver.detect().catch(() => false);
  const amneziawg = await amneziawgDriver.detect().catch(() => false);
  const wireguard = await ok('sh', ['-c', 'command -v wg >/dev/null 2>&1']);
  const proxy = await httpProxyDriver.detect().catch(() => false);

  let xrayUuids: string[] = [];
  let awgPublicKeys: string[] = [];
  if (xray) {
    try {
      xrayUuids = (await xrayDriver.importAccess()).map((d) => d.ref.id);
    } catch (e) {
      notes.push(`Xray: не удалось прочитать конфиг (${e instanceof Error ? e.message : 'ошибка'})`);
    }
  }
  if (amneziawg) {
    try {
      awgPublicKeys = (await amneziawgDriver.importAccess()).map((d) => d.ref.id);
    } catch (e) {
      notes.push(`AmneziaWG: не удалось прочитать конфиг (${e instanceof Error ? e.message : 'ошибка'})`);
    }
  }

  return {
    os: osName,
    dockerInstalled,
    containers,
    detected: { xray, amneziawg, wireguard, proxy },
    discovered: { xrayUuids, awgPublicKeys },
    notes,
  };
}
