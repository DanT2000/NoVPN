// Периодическая синхронизация статистики с VPN-серверов по SSH.
// AmneziaWG: awg show awg0 dump → rx/tx + last-handshake по пирам.
// Xray: xray api statsquery --reset → трафик по клиентам (нужен stats API).
// Сервер может отдавать и то, и другое одновременно (Finland).

import * as repo from '../repo.js';
import { sshHasSshAccess, sshPing, sshSyncAwg, sshSyncXray } from './sshServer.js';

let running = false;

export async function syncAllServers(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Автоотключение неактивных устройств (если включено в настройках).
    try {
      const days = Number(repo.getSettings()?.inactiveDisableDays ?? 0);
      if (days > 0) repo.disableInactiveDevices(days);
    } catch (e) {
      repo.addJobError('панель', `Автоотключение устройств: ${e instanceof Error ? e.message : 'ошибка'}`);
    }
    for (const s of repo.listServers()) {
      if (!(await sshHasSshAccess(s.id))) continue;

      const hasAwg = s.protocols.includes('amneziawg');
      const hasXray = s.protocols.includes('xray');
      const devices = repo.listServerDeviceKeys(s.id);
      const affected = new Set<string>();
      let serverBytes = 0;
      let reachable = false;

      // --- AmneziaWG ---
      if (hasAwg) {
        try {
          const peers = await sshSyncAwg(s.id);
          reachable = true;
          const byKey = new Map(peers.map((p) => [p.publicKey, p]));
          for (const d of devices) {
            if (d.protocol !== 'amneziawg' || !d.publicKey) continue;
            const p = byKey.get(d.publicKey);
            if (!p) continue;

            // Счётчики ядра обнуляются при перезапуске интерфейса (awg-quick
            // down/up, ребут). Раньше сырое значение писалось поверх накопленного,
            // и потреблённый трафик обнулялся — квоту можно было сбросить
            // перезапуском. Копим сами: прирост с прошлого замера, падение
            // счётчика трактуем как сброс.
            const prev = repo.getDeviceCounters(d.id);
            const rxDelta = p.rx >= prev.rxRaw ? p.rx - prev.rxRaw : p.rx;
            const txDelta = p.tx >= prev.txRaw ? p.tx - prev.txRaw : p.tx;
            const rxTotal = prev.rxTotal + rxDelta;
            const txTotal = prev.txTotal + txDelta;
            serverBytes += rxTotal + txTotal;

            const fields: Record<string, unknown> = {
              received_bytes: rxTotal,
              sent_bytes: txTotal,
              rx_raw: p.rx,
              tx_raw: p.tx,
              traffic_gb: (rxTotal + txTotal) / 1e9,
            };
            if (p.handshake > 0) fields.last_seen_at = new Date(p.handshake * 1000).toISOString();
            repo.updateDeviceFields(d.id, fields);
            if (d.userId) affected.add(d.userId);
          }
        } catch (e) {
          repo.addJobError(s.name, `Синхронизация AWG: ${e instanceof Error ? e.message : 'сервер недоступен'}`);
        }
      }

      // --- Xray (stats API, statsquery --reset даёт дельту с прошлого замера) ---
      if (hasXray) {
        try {
          const stats = await sshSyncXray(s.id);
          reachable = true;
          const byUuid = new Map(stats.map((x) => [x.uuid, x]));
          const now = repo.nowIso();
          for (const d of devices) {
            if (d.protocol !== 'xray' || !d.uuid) continue;
            const x = byUuid.get(d.uuid);
            if (!x) continue;
            // --reset вернул уже дельту → просто прибавляем к накопленному.
            const prev = repo.getDeviceCounters(d.id);
            const rxTotal = prev.rxTotal + (x.down || 0); // приём пользователем = downlink
            const txTotal = prev.txTotal + (x.up || 0); // отдача пользователем = uplink
            serverBytes += rxTotal + txTotal;

            const fields: Record<string, unknown> = {
              received_bytes: rxTotal,
              sent_bytes: txTotal,
              traffic_gb: (rxTotal + txTotal) / 1e9,
            };
            // Был трафик в этом цикле → устройство сейчас активно.
            if ((x.up || 0) + (x.down || 0) > 0) fields.last_seen_at = now;
            repo.updateDeviceFields(d.id, fields);
            if (d.userId) affected.add(d.userId);
          }
        } catch (e) {
          repo.addJobError(s.name, `Синхронизация Xray: ${e instanceof Error ? e.message : 'сервер недоступен'}`);
        }
      }

      // --- сервер без собираемой статистики: просто проверяем живость ---
      if (!hasAwg && !hasXray) {
        try {
          await sshPing(s.id);
          reachable = true;
        } catch {
          /* offline ниже */
        }
      }

      if (reachable) {
        repo.updateServerFields(s.id, {
          agent: 'online',
          endpoint_ok: 1,
          last_sync_at: repo.nowIso(),
          traffic_gb: serverBytes / 1e9,
        });
      } else {
        // Раньше статус был односторонней защёлкой: «online» ставился при
        // установке и не снимался никогда — упавший сервер вечно горел зелёным.
        repo.updateServerFields(s.id, { agent: 'offline', endpoint_ok: 0 });
      }
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
