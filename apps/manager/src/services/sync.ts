// Периодическая синхронизация статистики с VPN-серверов по SSH.
// Сейчас: AmneziaWG (awg show awg0 dump) → rx/tx + last-handshake по пирам.
// Xray требует включённого stats API (пока не собираем).

import * as repo from '../repo.js';
import { sshHasSshAccess, sshSyncAwg } from './sshServer.js';

let running = false;

export async function syncAllServers(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const s of repo.listServers()) {
      if (!s.protocols.includes('amneziawg')) continue;
      if (!(await sshHasSshAccess(s.id))) continue;

      let peers: Array<{ publicKey: string; handshake: number; rx: number; tx: number }>;
      try {
        peers = await sshSyncAwg(s.id);
      } catch (e) {
        // Сервер недоступен — фиксируем в «Ошибки заданий» (не чаще раза в цикл) и идём дальше.
        repo.addJobError(s.name, `Синхронизация: ${e instanceof Error ? e.message : 'сервер недоступен'}`);
        continue;
      }
      const byKey = new Map(peers.map((p) => [p.publicKey, p]));
      const devices = repo.listServerDeviceKeys(s.id).filter((d) => d.protocol === 'amneziawg' && d.publicKey);
      const affected = new Set<string>();
      let serverBytes = 0;

      for (const d of devices) {
        const p = byKey.get(d.publicKey!);
        if (!p) continue;
        const total = p.rx + p.tx;
        serverBytes += total;
        const fields: Record<string, unknown> = {
          received_bytes: p.rx,
          sent_bytes: p.tx,
          traffic_gb: total / 1e9,
        };
        if (p.handshake > 0) fields.last_seen_at = new Date(p.handshake * 1000).toISOString();
        repo.updateDeviceFields(d.id, fields);
        if (d.userId) affected.add(d.userId);
      }

      repo.updateServerFields(s.id, { last_sync_at: repo.nowIso(), traffic_gb: serverBytes / 1e9 });
      for (const uid of affected) repo.recomputeUserUsage(uid);
    }
  } finally {
    running = false;
  }
}

export function startSyncLoop(intervalMs = 60_000): void {
  const t = setInterval(() => void syncAllServers(), intervalMs);
  t.unref?.();
  // первый прогон вскоре после старта
  setTimeout(() => void syncAllServers(), 8_000).unref?.();
}
