// Периодическая синхронизация статистики с VPN-серверов по SSH.
// AmneziaWG: awg show awg0 dump → rx/tx + last-handshake по пирам.
// Xray: xray api statsquery --reset → трафик по клиентам (нужен stats API).
// Сервер может отдавать и то, и другое одновременно (Finland).

import * as repo from '../repo.js';
import { sshHasSshAccess, sshPing, sshSyncAwg, sshSyncXray, sshReadProxyTraffic, sshRevokeAwg, sshRevokeXray, sshRevokeProxyUser, sshAddProxyUser, sshResyncDevices, sshSetXraySni, REALITY_SNI } from './sshServer.js';
import { getServerKeys } from './keyvault.js';
import { notifyAdmin } from './telegram.js';

const PROXY_PROTOS = ['http', 'https', 'socks5'];

let running = false;
// Сервера, у которых reality-SNI уже сверен с сохранённым в этом процессе — чтобы
// не дёргать SSH каждый цикл. sshSetXraySni идемпотентна (без рестарта, если совпало).
const sniReconciled = new Set<string>();

export async function syncAllServers(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Автоочистка отозванных/отключённых записей старше grace: конфиг на сервере
    // уже мёртв, запись только засоряет список пользователя и включить её нельзя.
    try {
      const removed = repo.cleanupRevokedDevices();
      if (removed) repo.addLog(`Автоочистка отозванных конфигов: ${removed}`);
    } catch (e) {
      repo.addJobError('панель', `Автоочистка отозванных: ${e instanceof Error ? e.message : 'ошибка'}`);
    }
    // Повтор отложенных отзывов: устройства, чей серверный отзыв не прошёл (сервер был
    // недоступен при revoke/cleanup/удалении). Пока отзыв не подтверждён — запись не
    // чистится (revoke_pending=1), а «отключённый» конфиг мог бы жить на сервере. Здесь
    // добиваем отзыв, как только сервер снова доступен.
    try {
      for (const d of repo.listRevokePendingDevices()) {
        const server = repo.getServer(d.serverId);
        // Намерение закодировано в pending: 1 → чистить (revoked_at), 2 → приостановка
        // (подтверждаем отзыв, но запись храним до реактивации).
        const forCleanup = d.pending === 1;
        if (!server) { repo.markDeviceRevokeConfirmed(d.id, forCleanup); continue; } // сервера нет — отзывать негде
        if (!(await sshHasSshAccess(server.id))) continue; // всё ещё недоступен — повторим позже
        try {
          if (d.protocol === 'amneziawg' && d.publicKey) await sshRevokeAwg(server, d.publicKey);
          else if (d.protocol === 'xray' && d.uuid) await sshRevokeXray(server, d.uuid);
          repo.markDeviceRevokeConfirmed(d.id, forCleanup);
        } catch {
          /* сервер снова недоступен — оставим pending до следующего цикла */
        }
      }
    } catch (e) {
      repo.addJobError('панель', `Повтор отложенных отзывов: ${e instanceof Error ? e.message : 'ошибка'}`);
    }
    // Автоотключение неактивных устройств (если включено в настройках) — и
    // реальный отзыв на сервере, иначе отключённый конфиг продолжал бы работать.
    try {
      const days = Number(repo.getSettings()?.inactiveDisableDays ?? 0);
      if (days > 0) {
        for (const d of repo.disableInactiveDevices(days)) {
          const server = repo.getServer(d.serverId);
          // Сервер недоступен — оставляем как revoke_pending=1: retry-проход добьёт
          // отзыв позже, а запись не удалится, пока он не подтверждён.
          if (!server || !(await sshHasSshAccess(server.id))) continue;
          try {
            if (d.protocol === 'amneziawg' && d.publicKey) await sshRevokeAwg(server, d.publicKey);
            else if (d.protocol === 'xray' && d.uuid) await sshRevokeXray(server, d.uuid);
            repo.markDeviceRevokeConfirmed(d.id, true); // подтверждён → revoked_at, автоочистка через grace
          } catch {
            /* сервер недоступен — останется revoke_pending, retry-проход повторит */
          }
        }
      }
    } catch (e) {
      repo.addJobError('панель', `Автоотключение устройств: ${e instanceof Error ? e.message : 'ошибка'}`);
    }
    for (const s of repo.listServers()) {
      if (s.detached) continue; // endpoint сохранён, физического сервера нет — sync пропускает
      if (!(await sshHasSshAccess(s.id))) continue;

      const hasAwg = s.protocols.includes('amneziawg');
      const hasXray = s.protocols.includes('xray');
      const hasProxy = (s.protocols as string[]).some((p) => PROXY_PROTOS.includes(p));

      // Авто-сверка reality-SNI: если сохранённый SNI сервера = наш дефолт
      // (миграция уже перевела на cdn.dodostatic.net), но server.json на сервере
      // ещё не приведён — применяем один раз за процесс. Закрывает разрыв
      // «ссылки обновлены, а сервер нет» без ручного действия и без UI.
      if (hasXray && !sniReconciled.has(s.id)) {
        try {
          if (getServerKeys(s.host)?.xraySni === REALITY_SNI) {
            await sshSetXraySni(s);
          }
          sniReconciled.add(s.id);
        } catch (e) {
          repo.addJobError(s.name, `Сверка reality-SNI: ${e instanceof Error ? e.message : 'ошибка'}`);
        }
      }
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

      // --- Прокси (3proxy): трафик по логинам из логов, суточный файл ---
      if (hasProxy) {
        try {
          const traffic = await sshReadProxyTraffic(s.id);
          reachable = true;
          const byLogin = new Map(traffic.map((t) => [t.login, t.bytes]));
          const now = repo.nowIso();
          for (const acc of repo.listServerProxyAccounts(s.id)) {
            const raw = byLogin.get(acc.login);
            if (raw == null) continue;
            // raw — суммарный трафик за СЕГОДНЯ. При суточной ротации лога он
            // падает (новый файл) → трактуем как сброс и берём весь raw.
            const prev = repo.getProxyCounters(acc.id);
            const delta = raw >= prev.rxRaw ? raw - prev.rxRaw : raw;
            const total = prev.total + delta;
            serverBytes += total;
            repo.updateProxyAccountTraffic(acc.id, {
              receivedBytes: total,
              sentBytes: 0,
              rxRaw: raw,
              lastSeenAt: delta > 0 ? now : undefined,
            });
            // Трафик прокси теперь входит в квоту → пересчитать расход пользователя,
            // даже если у него не было трафика по устройствам в этом цикле.
            if (acc.user_id) affected.add(acc.user_id);
          }
        } catch (e) {
          repo.addJobError(s.name, `Синхронизация прокси: ${e instanceof Error ? e.message : 'сервер недоступен'}`);
        }
      }

      // --- сервер без собираемой статистики: просто проверяем живость ---
      if (!hasAwg && !hasXray && !hasProxy) {
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

    // Квота исчерпана → гасим прокси-логины на серверах ОБРАТИМО (quota_blocked=1,
    // is_active остаётся 1), симметрично AWG/Xray. При возврате под лимит логин
    // поднимается заново тем же паролем. Флаг ставим ТОЛЬКО после подтверждённого
    // снятия на сервере (иначе живой логин осиротеет сверх квоты).
    try {
      for (const acc of repo.listProxyAccountsOverQuota()) {
        const server = repo.getServer(acc.serverId);
        if (!server) { repo.deactivateProxyAccount(acc.id); continue; } // сервера нет — гасить негде
        if (!(await sshHasSshAccess(server.id))) continue; // недоступен — повторим в следующем цикле
        try {
          await sshRevokeProxyUser(server, acc.login);
          repo.setProxyQuotaBlocked(acc.id, true);
        } catch {
          /* сервер недоступен — повторим в следующем цикле */
        }
      }
      // Возврат под лимит → поднимаем снятые по квоте прокси-логины обратно.
      for (const acc of repo.listProxyAccountsToRestore()) {
        const server = repo.getServer(acc.serverId);
        if (!server || !(await sshHasSshAccess(server.id))) continue;
        try {
          await sshAddProxyUser(server, acc.login, acc.pass);
          repo.setProxyQuotaBlocked(acc.id, false);
        } catch {
          /* недоступен — повторим */
        }
      }
    } catch (e) {
      repo.addJobError('панель', `Enforcement прокси по квоте: ${e instanceof Error ? e.message : 'ошибка'}`);
    }

    // Квота по AmneziaWG/Xray: снимаем пир/uuid С СЕРВЕРА при исчерпании лимита (иначе
    // уже импортированный конфиг тоннелит сверх квоты — у WireGuard нет авто-отключения).
    // Запись и ключи храним (quota_blocked=1); при восстановлении лимита пир возвращаем
    // тем же ключом — клиентский .conf работает без изменений, reissue не нужен.
    try {
      for (const d of repo.listDevicesToBlockForQuota()) {
        const server = repo.getServer(d.serverId);
        if (!server || !(await sshHasSshAccess(server.id))) continue; // недоступен — повторим в след. цикле
        const row = repo.getDeviceRow(d.id);
        try {
          if (d.protocol === 'amneziawg' && row?.public_key) await sshRevokeAwg(server, row.public_key);
          else if (d.protocol === 'xray' && row?.uuid) await sshRevokeXray(server, row.uuid);
          repo.setQuotaBlocked(d.id, true);
        } catch {
          /* сервер недоступен — оставим quota_blocked=0, повторим */
        }
      }
      // Восстановление: пользователь снова под лимитом → возвращаем снятые пиры на сервер.
      const restore = repo.listDevicesToRestoreFromQuota();
      const byServer = new Map<string, typeof restore>();
      for (const d of restore) (byServer.get(d.serverId) ?? byServer.set(d.serverId, []).get(d.serverId)!).push(d);
      for (const [serverId, items] of byServer) {
        const server = repo.getServer(serverId);
        if (!server || !(await sshHasSshAccess(server.id))) continue;
        try {
          const applied = await sshResyncDevices(server, items.map((d) => ({ name: d.name, protocol: d.protocol, uuid: d.uuid, awgPub: d.awgPub, clientIp: d.clientIp, psk: d.psk })));
          const okXray = new Set(applied.xray);
          const okAwg = new Set(applied.awg);
          // Снимаем quota_blocked только с пиров, реально применённых на сервере (#17):
          // устройство с битым/пропущенным ключом останется blocked и повторится.
          for (const d of items) {
            const ok = d.protocol === 'xray' ? !!d.uuid && okXray.has(d.uuid) : !!d.awgPub && okAwg.has(d.awgPub);
            if (ok) repo.setQuotaBlocked(d.id, false);
          }
        } catch {
          /* сервер недоступен — повторим */
        }
      }
    } catch (e) {
      repo.addJobError('панель', `Enforcement квоты AWG/Xray: ${e instanceof Error ? e.message : 'ошибка'}`);
    }

    // Мониторинг: аптайм серверов (событие при смене online/offline), снимок метрик
    // для графиков истории, и ежедневная сводка администратору в Telegram.
    try {
      for (const s of repo.listServers()) if (!s.detached) repo.recordServerStatus(s.id, s.agent === 'online');
      repo.recordStatsSample();
      if (repo.getSettings().dailyDigest !== false) {
        const digest = repo.buildDailyDigestIfDue();
        if (digest) void notifyAdmin(digest, { key: 'daily-digest', minGapMs: 0 }).catch(() => {});
      }
    } catch (e) {
      repo.addJobError('панель', `Мониторинг/сводка: ${e instanceof Error ? e.message : 'ошибка'}`, 'warn');
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
