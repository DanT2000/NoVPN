// Периодическая синхронизация статистики с VPN-серверов по SSH.
// Сейчас: AmneziaWG (awg show awg0 dump) → rx/tx + last-handshake по пирам.
// Xray требует включённого stats API (пока не собираем).

import * as repo from '../repo.js';
import { sshHasSshAccess, sshPing, sshSyncAwg } from './sshServer.js';

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

      // Xray-серверы статистику пока не отдают, но их доступность проверить надо —
      // иначе упавший Xray-сервер вечно «online». Лёгкая проверка живости по SSH.
      if (!s.protocols.includes('amneziawg')) {
        try {
          await sshPing(s.id);
          repo.updateServerFields(s.id, { agent: 'online', endpoint_ok: 1, last_sync_at: repo.nowIso() });
        } catch {
          repo.updateServerFields(s.id, { agent: 'offline', endpoint_ok: 0 });
        }
        continue;
      }

      let peers: Array<{ publicKey: string; handshake: number; rx: number; tx: number }>;
      try {
        peers = await sshSyncAwg(s.id);
      } catch (e) {
        // Сервер не ответил по SSH — помечаем offline. Раньше статус был
        // односторонней защёлкой: «online» ставился при установке и не снимался
        // никогда, поэтому упавший сервер вечно горел зелёным на обзоре.
        repo.updateServerFields(s.id, { agent: 'offline', endpoint_ok: 0 });
        repo.addJobError(s.name, `Синхронизация: ${e instanceof Error ? e.message : 'сервер недоступен'}`);
        continue;
      }
      // Достучались — сервер жив.
      repo.updateServerFields(s.id, { agent: 'online', endpoint_ok: 1 });
      const byKey = new Map(peers.map((p) => [p.publicKey, p]));
      const devices = repo.listServerDeviceKeys(s.id).filter((d) => d.protocol === 'amneziawg' && d.publicKey);
      const affected = new Set<string>();
      let serverBytes = 0;

      for (const d of devices) {
        const p = byKey.get(d.publicKey!);
        if (!p) continue;

        // Счётчики ядра обнуляются при перезапуске интерфейса (awg-quick down/up,
        // ребут сервера). Раньше сырое значение писалось поверх накопленного, и
        // потреблённый трафик пользователя обнулялся вместе с ним — то есть
        // квоту можно было сбросить перезапуском. Поэтому копим сами: считаем
        // прирост с прошлого замера, а падение счётчика трактуем как сброс.
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
