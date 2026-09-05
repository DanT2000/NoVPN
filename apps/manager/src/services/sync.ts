// Периодическая синхронизация статистики с VPN-серверов по SSH.
// AmneziaWG: awg show awg0 dump → rx/tx + last-handshake по пирам.
// Xray: xray api statsquery --reset → трафик по клиентам (нужен stats API).
// Сервер может отдавать и то, и другое одновременно (Finland).

import * as repo from '../repo.js';
import { getSetting, setSetting } from '../db.js';
import { sshHasSshAccess, sshPing, sshSyncAwg, sshSyncXray, sshReadProxyTraffic, sshRevokeAwg, sshRevokeXray, sshRevokeProxyUser, sshAddProxyUser, sshResyncDevices, sshSetXraySni, sshReadMetrics, REALITY_SNI } from './sshServer.js';
import type { ServerMetrics } from './sshServer.js';
import { getServerKeys } from './keyvault.js';
import { notifyAdmin, notifyUser } from './telegram.js';

const PROXY_PROTOS = ['http', 'https', 'socks5'];

let running = false;
// Сервера, у которых reality-SNI уже сверен с сохранённым в этом процессе — чтобы
// не дёргать SSH каждый цикл. sshSetXraySni идемпотентна (без рестарта, если совпало).
const sniReconciled = new Set<string>();

// Дебаунс sync-ошибок: сервер за NAT / упавший заваливал бы журнал (кап 100 строк) и
// вытеснял полезное у других серверов. Пишем не чаще раза в 30 мин; успешный проход
// сбрасывает счётчик. ВАЖНО: таймаут рукопожатия/коннекта = сервер НЕДОСТУПЕН ЦЕЛИКОМ,
// дедупим по СЕРВЕРУ (одна ошибка «сервер недоступен», а не 4 — по каждой операции).
// Прикладную ошибку конкретной операции дедупим по (сервер+операция), как раньше.
const lastSyncErrAt = new Map<string, number>();
const UNREACHABLE_RE = /timed out|handshake|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|таймаут/i;
function logSyncError(serverName: string, serverId: string, op: string, e: unknown): void {
  const msg = e instanceof Error ? e.message : 'сервер недоступен';
  const unreachable = UNREACHABLE_RE.test(msg);
  const key = unreachable ? `${serverId}|__unreachable__` : `${serverId}|${op}`;
  const now = Date.now();
  if (now - (lastSyncErrAt.get(key) ?? 0) < 30 * 60 * 1000) return;
  lastSyncErrAt.set(key, now);
  repo.addJobError(serverName, unreachable ? `Сервер недоступен: ${msg}` : `${op}: ${msg}`);
}
function clearSyncErr(serverId: string, op: string): void {
  lastSyncErrAt.delete(`${serverId}|${op}`);
  lastSyncErrAt.delete(`${serverId}|__unreachable__`); // сервер ответил — снимаем и «недоступен»
}

// Нагрузку снимаем раз в минуту: реже — и пики сетевой скорости (нужны, чтобы понять,
// хватает ли канала) размажутся до неузнаваемости. Замер CPU держит SSH ~1 с на
// сервер — при паре серверов это ничего. Точка в минуту = ~1.5 МБ в месяц на сервер.
const lastMetricsAt = new Map<string, number>();
const METRICS_GAP_MS = 60 * 1000;

const asGb = (b: number) => `${(b / 1e9).toFixed(1)} ГБ`;

/** Предупреждения по нагрузке. Пороги консервативные, чтобы не спамить: диск важнее
 *  всего — он забивается логами тихо и роняет сервер без единого сигнала. CPU шлём
 *  только если держится высоким несколько замеров подряд, иначе всплеск = ложная тревога. */
async function checkLoadAlerts(name: string, id: string, m: ServerMetrics): Promise<void> {
  const pct = (used: number, total: number) => (total > 0 ? (used / total) * 100 : 0);
  const day = 12 * 3600 * 1000; // не чаще двух раз в сутки на каждый вид
  const disk = pct(m.diskUsed, m.diskTotal);
  if (disk >= 90) {
    await notifyAdmin(
      `Сервер «${name}»: диск занят на ${disk.toFixed(0)}% (${asGb(m.diskUsed)} из ${asGb(m.diskTotal)}). Стоит почистить логи, иначе сервер встанет.`,
      { key: `load-disk:${id}`, minGapMs: day },
    );
  }
  const mem = pct(m.memUsed, m.memTotal);
  if (mem >= 92) {
    await notifyAdmin(`Сервер «${name}»: память занята на ${mem.toFixed(0)}% (${asGb(m.memUsed)} из ${asGb(m.memTotal)}).`, {
      key: `load-mem:${id}`,
      minGapMs: day,
    });
  }
  // CPU: только устойчивая нагрузка — три последних замера (≈15 минут) подряд ≥90%.
  if (m.cpuPct >= 90) {
    const recent = repo.getServerMetrics(id, 20 * 60 * 1000);
    if (recent.length >= 3 && recent.slice(-3).every((s) => s.cpuPct >= 90)) {
      await notifyAdmin(`Сервер «${name}»: процессор держится на ${m.cpuPct.toFixed(0)}% уже ~15 минут.`, {
        key: `load-cpu:${id}`,
        minGapMs: day,
      });
    }
  }
}

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

      // Нагрузка сервера: CPU/ОЗУ/диск/сеть тем же заходом по SSH, раз в 5 минут.
      // Пишем ДО проверки порогов, чтобы свежий замер попал в оценку «держится ли CPU».
      if (Date.now() - (lastMetricsAt.get(s.id) ?? 0) >= METRICS_GAP_MS) {
        lastMetricsAt.set(s.id, Date.now());
        try {
          const m = await sshReadMetrics(s.id);
          if (m) {
            repo.recordServerMetrics(s.id, m);
            await checkLoadAlerts(s.name, s.id, m);
          }
          clearSyncErr(s.id, 'Метрики нагрузки');
        } catch (e) {
          logSyncError(s.name, s.id, 'Метрики нагрузки', e);
        }
      }

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
          logSyncError(s.name, s.id, 'Сверка reality-SNI', e);
        }
      }
      const devices = repo.listServerDeviceKeys(s.id);
      const affected = new Set<string>();
      let reachable = false;

      // --- AmneziaWG ---
      if (hasAwg) {
        try {
          const peers = await sshSyncAwg(s.id);
          reachable = true;
          clearSyncErr(s.id, 'Синхронизация AWG');
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

            const fields: Record<string, unknown> = {
              received_bytes: rxTotal,
              sent_bytes: txTotal,
              rx_raw: p.rx,
              tx_raw: p.tx,
              traffic_gb: (rxTotal + txTotal) / 1e9,
            };
            if (p.handshake > 0) fields.last_seen_at = new Date(p.handshake * 1000).toISOString();
            repo.updateDeviceFields(d.id, fields);
            // Тот же прирост кладём в посуточную разбивку — по ней потом видно,
            // кто именно израсходовал трафик в конкретный день.
            repo.addTrafficSample(d.id, rxDelta + txDelta);
            if (d.userId) affected.add(d.userId);
          }
        } catch (e) {
          logSyncError(s.name, s.id, 'Синхронизация AWG', e);
        }
      }

      // --- Xray (stats API, statsquery --reset даёт дельту с прошлого замера) ---
      if (hasXray) {
        try {
          const stats = await sshSyncXray(s.id);
          reachable = true;
          clearSyncErr(s.id, 'Синхронизация Xray');
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

            const fields: Record<string, unknown> = {
              received_bytes: rxTotal,
              sent_bytes: txTotal,
              traffic_gb: (rxTotal + txTotal) / 1e9,
            };
            // Был трафик в этом цикле → устройство сейчас активно.
            if ((x.up || 0) + (x.down || 0) > 0) fields.last_seen_at = now;
            repo.updateDeviceFields(d.id, fields);
            // Тот же прирост — в посуточную разбивку (кто израсходовал и когда).
            repo.addTrafficSample(d.id, (x.up || 0) + (x.down || 0));
            if (d.userId) affected.add(d.userId);
          }
        } catch (e) {
          logSyncError(s.name, s.id, 'Синхронизация Xray', e);
        }
      }

      // --- Прокси (3proxy): трафик по логинам из логов, суточный файл ---
      if (hasProxy) {
        try {
          const traffic = await sshReadProxyTraffic(s.id);
          reachable = true;
          clearSyncErr(s.id, 'Синхронизация прокси');
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
          logSyncError(s.name, s.id, 'Синхронизация прокси', e);
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
          // Итог из накопленных счётчиков всех устройств сервера в БД (updateDeviceFields
          // выше уже записал текущий цикл). Устойчиво к частичному замеру: устройства,
          // не попавшие в этот цикл, сохраняют прошлое значение и не обнуляют итог.
          traffic_gb: repo.serverTrafficGb(s.id),
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
      const quotaBlockedUsers = new Set<string>();
      for (const d of repo.listDevicesToBlockForQuota()) {
        const server = repo.getServer(d.serverId);
        if (!server || !(await sshHasSshAccess(server.id))) continue; // недоступен — повторим в след. цикле
        const row = repo.getDeviceRow(d.id);
        try {
          if (d.protocol === 'amneziawg' && row?.public_key) await sshRevokeAwg(server, row.public_key);
          else if (d.protocol === 'xray' && row?.uuid) await sshRevokeXray(server, row.uuid);
          repo.setQuotaBlocked(d.id, true);
          // Человеку надо сказать, почему у него перестало работать. Для AmneziaWG это
          // особенно важно: пир просто исчезает с сервера, клиент никакой ошибки не
          // показывает — со стороны это выглядит как «VPN сломался сам по себе».
          if (d.userId) quotaBlockedUsers.add(d.userId);
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
      // Предупреждение ДО отключения: осталось меньше 10% лимита. Пишем не на
      // каждые 0.1 ГБ (иначе при лимите 100–200 ГБ человек получил бы сотню
      // сообщений за один спуск), а на переходах через грубые ПОРОГИ остатка.
      // Ключ хранит последний порог, о котором предупредили.
      const LOW_THRESHOLDS = [10, 5, 2, 1]; // проценты остатка, от мягкого к срочному
      for (const u of repo.listUsersLowOnTraffic(0.1)) {
        const key = `low-traffic:${u.id}:${u.limitGb}`;
        const leftGb = Math.max(0, u.limitGb - u.usedGb);
        const leftPct = u.limitGb > 0 ? (leftGb / u.limitGb) * 100 : 0;
        // Самый низкий (самый срочный) уже пройденный порог.
        const crossed = LOW_THRESHOLDS.filter((t) => leftPct <= t);
        const level = crossed.length ? crossed[crossed.length - 1]! : null;
        if (level === null) continue; // ещё выше 10% — в норме сюда не попадём
        const stored = getSetting<number>(key, 0);
        const fresh = stored === 0; // ещё ни разу не предупреждали в этом цикле
        const moreUrgent = level < stored; // опустились к более срочному порогу
        // Остаток снова поднялся выше 5% — счётчик обнулился по тарифу, начинаем
        // цикл предупреждений заново (иначе после сброса человек их не получал бы).
        const cycledBack = !fresh && level >= 10 && stored < 10;
        if (!fresh && !moreUrgent && !cycledBack) continue;
        setSetting(key, level);
        await notifyUser(
          u.id,
          `Трафик заканчивается: осталось ${leftGb.toFixed(1)} ГБ из ${u.limitGb} ГБ.

` +
            'Когда лимит исчерпается, доступ приостановится до обнуления счётчика по вашему тарифу.',
        );
      }

      // Отправляем по одному сообщению на человека, а не на каждое устройство.
      for (const userId of quotaBlockedUsers) {
        const u = repo.getUser(userId);
        if (!u) continue;
        const limit = u.trafficLimitGb ?? 0;
        await notifyUser(
          userId,
          `Лимит трафика исчерпан: ${(u.trafficUsedGb ?? 0).toFixed(1)} из ${limit} ГБ.

` +
            'Доступ приостановлен и восстановится сам, когда счётчик обнулится по вашему тарифу. ' +
            'Конфигурации перевыпускать не нужно — они продолжат работать.',
        );
      }
    } catch (e) {
      repo.addJobError('панель', `Enforcement квоты AWG/Xray: ${e instanceof Error ? e.message : 'ошибка'}`);
    }

    // Мониторинг: аптайм серверов (событие при смене online/offline), снимок метрик
    // для графиков истории, и ежедневная сводка администратору в Telegram.
    try {
      for (const s of repo.listServers()) if (!s.detached) repo.recordServerStatus(s.id, s.agent === 'online');
      repo.recordStatsSample();
      repo.pruneTraffic(); // почасовые подробности расхода держим месяц
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
